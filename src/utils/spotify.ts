import { filter, find, flattenDeep, shuffle, startsWith } from 'lodash';
import { serialAsyncForEach } from '.';
import { useAppStore } from '../store';
import { ACTION } from '../components/Progress';

let accessToken: string | null = null;

export const setAccessToken = (token: string) => accessToken = token;

const performRequest = (url: string, method: string = 'GET', body?: any) =>
  fetch(url, {
    method: method,
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      Authorization: `Bearer ${accessToken}`,
    }
  })
    .then(async response => {
      const json = await response.json();
      if (response.ok)
        return json;

      throw new Error(`${response.status}: ${json.error?.message}`);
    })

const fetchSavedTracks = async (items: any[] = [], url: string | null = null): Promise<any[]> => {
  const response = await performRequest(url || `https://api.spotify.com/v1/me/tracks?offset=0&limit=50`);
  const cItems = [...items, ...response.items];

  if (response.next)
    return fetchSavedTracks(cItems, response.next);
  else
    return cItems;
}

const fetchSavedPlaylists = async (items: any[] = [], url: string | null = null): Promise<any[]> => {
  const response = await performRequest(url || `https://api.spotify.com/v1/me/playlists?offset=0&limit=50`);
  const cItems = [...items, ...response.items];

  if (response.next)
    return fetchSavedPlaylists(cItems, response.next);
  else
    return cItems;
}

const fetchPlaylistItemURLs = async (playlistId: string, items: any[] = [], url: string | null = null): Promise<string[]> => {
  const response = await performRequest(url || `https://api.spotify.com/v1/playlists/${playlistId}/tracks?fields=limit,next,items(track(uri))&limit=100`);
  const cItems = [...items, ...response.items.map((i: any) => i.track ? i.track.uri : null).filter((i: string) => i)];

  if (response.next)
    return fetchPlaylistItemURLs(playlistId, cItems, response.next);
  else
    return cItems;
}

const fetchUserInfo = async () => {
  useAppStore.getState().setActionStart(ACTION.fetchUser);
  try {
    const response = await performRequest(`https://api.spotify.com/v1/me`);
    useAppStore.getState().setActionCompleted(ACTION.fetchUser);
    return response;
  } catch (error) {
    useAppStore.getState().setActionFailed(ACTION.fetchUser, `https://api.spotify.com/v1/me`, error);
  }
}

const getRecommendations = (seedTrack: string, limit: number) =>
  performRequest(`https://api.spotify.com/v1/recommendations?seed_tracks=${seedTrack}&limit=${limit}`);

const fetchAllSavedTracks = () => fetchSavedTracks();
const fetchAllSavedPlaylists = () => fetchSavedPlaylists();
const fetchAllPlaylistTrackUris = (playlistId: string): Promise<string[]> => fetchPlaylistItemURLs(playlistId)

const getExistingPlaylist = async (userId: string, name: string) => {
  useAppStore.getState().setActionStart(ACTION.getExistingPlaylist);
  return fetchAllSavedPlaylists()
    .then((playlists) => {
      useAppStore.getState().setActionCompleted(ACTION.getExistingPlaylist);
      const existing = find(playlists, (i) => (i.owner.id === userId && i.name === name));
      return existing;
    })
    .catch((error: any) => {
      useAppStore.getState().setActionFailed(ACTION.getExistingPlaylist, `fetchAllSavedPlaylists`, error);
    })
}

const emptyPlaylist = async (playlistId: string) => {
  useAppStore.getState().setActionStart(ACTION.emptyExistingPlaylist);
  return fetchAllPlaylistTrackUris(playlistId)
    .then((uris) => {
      if (uris.length === 0) {
        useAppStore.getState().setActionSkipped(ACTION.emptyExistingPlaylist)
        return;
      }
      return performRequest(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, 'DELETE', {
        tracks: uris.map(uri => ({ uri: uri })),
      })
        .then((res) => {
          useAppStore.getState().setActionCompleted(ACTION.emptyExistingPlaylist);
          return res
        })
        .catch((error: any) => {
          useAppStore.getState().setActionFailed(ACTION.emptyExistingPlaylist, `DELETE https://api.spotify.com/v1/playlists/${playlistId}54/tracks`, error);
        })
    })
    .catch((error: any) => {
      useAppStore.getState().setActionFailed(ACTION.emptyExistingPlaylist, `fetchAllPlaylistTrackUris ${playlistId}`, error);
    })
}

const createPlaylist = async (userId: string, name: string) => {
  useAppStore.getState().setActionStart(ACTION.createEmptyPlaylist);
  try {
    const res = await performRequest(`https://api.spotify.com/v1/users/${userId}/playlists`, 'POST', {
      name,
      public: false,
      collaborative: false,
      description: 'Autogenerated playlist by Random Daily Drive',
    });
    useAppStore.getState().setActionCompleted(ACTION.createEmptyPlaylist);
    return res
  } catch (error) {
    useAppStore.getState().setActionFailed(ACTION.createEmptyPlaylist, `POST https://api.spotify.com/v1/users/${userId}/playlists`, error);
  }
}
  

const addTracks = async (playlistId: string, uris: string[]) => {
  useAppStore.getState().setActionStart(ACTION.addTracks);
  try {
    const res = await performRequest(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, 'POST', {
      uris: uris
    });
    useAppStore.getState().setActionCompleted(ACTION.addTracks);
    return res;
  } catch (error) {
    useAppStore.getState().setActionFailed(ACTION.addTracks, `POST https://api.spotify.com/v1/playlists/${playlistId}/tracks`, error);
  }
}

/**
 * Fetches the podcast episodes from the original Daily Drive playlist
 * Unfortunateley there is no better way to search the list than do it like this, it's not guaranteed we find it.
 */
const fetchDailyDrivePodcasts = async () => {
  useAppStore.getState().setActionStart(ACTION.getDDPodcasts)
  try {
    const searchResult = await performRequest(`https://api.spotify.com/v1/search/?type=playlist&q="Your Daily Drive"&limit=50`);
    // FIXME: what are the names of the Daily Drive playlist in other languages? Is there any way to universally identifiy that playlist?
    const dailyDrive = find(searchResult.playlists.items, (item) => (item.owner.id === 'spotify' && (item.name === 'Your Daily Drive' || item.name === 'Daily Drive')));
  
    if (!dailyDrive) {
      console.warn('Your Daily Drive could not be found. Skipping including podcasts.')
      return null;
    }
  
    const allTracks = await fetchAllPlaylistTrackUris(dailyDrive.id);
    const episodes = filter(allTracks, (uri) => startsWith(uri, 'spotify:episode:'));
    useAppStore.getState().setActionCompleted(ACTION.getDDPodcasts)
    return episodes;
  } catch (ex) {
    useAppStore.getState().setActionFailed(ACTION.getDDPodcasts, `search for Daily Drive playlist`, ex);
    return null
  }
}

export const generateDailyDrive = async (name: string, blocks: number, blockSize: number, withPodcasts: boolean) => {
  const user = await fetchUserInfo();

  let playlist = await getExistingPlaylist(user.id, name);

  if (playlist) {
    useAppStore.getState().setActionSkipped(ACTION.createEmptyPlaylist)
    await emptyPlaylist(playlist.id);
  } else {
    useAppStore.getState().setActionSkipped(ACTION.emptyExistingPlaylist)
    playlist = await createPlaylist(user.id, name);
    if (!playlist) {
      return;
    }
  }

  let seedTracks: any[]
  try {
    useAppStore.getState().setActionStart(ACTION.getTracks);
    const tracks = await fetchAllSavedTracks();
    seedTracks = shuffle(tracks).slice(0, blocks).map(i => i.track);
    useAppStore.getState().setActionCompleted(ACTION.getTracks, `Found ${tracks.length} tracks, picked ${seedTracks.length} random tracks.`);
  } catch (ex) {
    useAppStore.getState().setActionFailed(ACTION.getTracks, `fetchAllSavedTracks`, ex);
    return;
  }

  const recommendedBlocks = [];

  let episodeUris = null;
  if (withPodcasts) {
    episodeUris = await fetchDailyDrivePodcasts();
  } else {
    useAppStore.getState().setActionSkipped(ACTION.getDDPodcasts);
  }

  useAppStore.getState().setActionStart(ACTION.getRecommendations);
  try {
    await serialAsyncForEach(seedTracks, async (track) => {
      const recommendations = await getRecommendations(track.id, blockSize - 1)
      if (episodeUris) {
        const episodeUri = episodeUris.shift();
        if (episodeUri)
          recommendedBlocks.push(episodeUri);
      }
      recommendedBlocks.push(track.uri);
      recommendedBlocks.push(recommendations.tracks.map((i: any) => i.uri));
      return;
    });
    useAppStore.getState().setActionCompleted(ACTION.getRecommendations);
  } catch (ex) {
    useAppStore.getState().setActionFailed(ACTION.getRecommendations, `getRecommendations`, ex);
    return;
  }

  // finally if we have more podcasts left than blocks, we'll add them all in the last block
  if (episodeUris && episodeUris.length > 0) {
    recommendedBlocks.push(...episodeUris);
  }

  await addTracks(playlist.id, flattenDeep(recommendedBlocks));
  return playlist;
}
