import { config } from '../config';

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

const LIST_SOUND_ZONES = /* GraphQL */ `
  query ListSoundZones($accountLimit: Int!, $zoneLimit: Int!) {
    me {
      ... on PublicAPIClient {
        accounts(first: $accountLimit, orderBy: { field: BUSINESS_NAME, direction: ASC }) {
          edges {
            node {
              id
              businessName
              locations(first: 10) {
                edges {
                  node {
                    id
                    name
                    soundZones(first: $zoneLimit) {
                      edges {
                        node {
                          id
                          name
                          isPaused
                          isPlaying
                          nowPlaying {
                            track {
                              id
                              name
                              artists {
                                name
                              }
                              album {
                                name
                                image {
                                  url
                                  width
                                  height
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const NOW_PLAYING_QUERY = /* GraphQL */ `
  query NowPlaying($soundZone: ID!) {
    nowPlaying(soundZone: $soundZone) {
      startedAt
      state
      track {
        id
        name
        durationMs
        artists {
          name
        }
        album {
          name
          image {
            url
            width
            height
          }
        }
      }
    }
  }
`;

const SET_CONTENT_MUTATION = /* GraphQL */ `
  mutation SetSoundZoneContent($soundZone: ID!, $content: ID!) {
    setSoundZoneContent(input: { soundZone: $soundZone, content: $content }) {
      soundZone {
        id
      }
    }
  }
`;

const PLAY_MUTATION = /* GraphQL */ `
  mutation PlaySoundZone($soundZone: ID!) {
    playSoundZone(input: { soundZone: $soundZone }) {
      soundZone {
        id
      }
    }
  }
`;

const PAUSE_MUTATION = /* GraphQL */ `
  mutation PauseSoundZone($soundZone: ID!) {
    pauseSoundZone(input: { soundZone: $soundZone }) {
      soundZone {
        id
      }
    }
  }
`;

const SKIP_MUTATION = /* GraphQL */ `
  mutation SkipToNext($soundZone: ID!) {
    skipToNext(input: { soundZone: $soundZone }) {
      soundZone {
        id
      }
    }
  }
`;

const SEARCH_CONTENT_QUERY = /* GraphQL */ `
  query SearchSoundtrack($query: String!, $limit: Int!) {
    search(query: $query, first: $limit) {
      edges {
        node {
          __typename
          ... on TrackSearchResult {
            track {
              id
              name
              durationMs
              artists {
                name
              }
              album {
                name
                image {
                  url
                  width
                  height
                }
              }
            }
          }
          ... on PlaylistSearchResult {
            playlist {
              id
              name
              description
              image {
                url
                width
                height
              }
            }
          }
        }
      }
    }
  }
`;

export type SoundtrackSearchResult = {
  type: 'track' | 'playlist' | 'unknown';
  id: string;
  name: string;
  artists?: string[];
  description?: string | null;
  imageUrl?: string | null;
  durationMs?: number | null;
};

export type SoundtrackNowPlaying = {
  startedAt: string | null;
  state: string | null;
  track: {
    id: string;
    name: string;
    durationMs: number | null;
    artists: Array<{ name: string }>;
    album: {
      name: string;
      image: {
        url: string;
        width: number;
        height: number;
      } | null;
    } | null;
  } | null;
};

class SoundtrackService {
  private readonly endpoint = config.soundtrack.apiEndpoint;
  private readonly token = config.soundtrack.apiToken;

  private async execute<T>(query: string, variables?: Record<string, unknown>, operationName?: string): Promise<T> {
    const fetchFn = (globalThis as any).fetch;

    if (typeof fetchFn !== 'function') {
      throw new Error('Global fetch implementation is not available. Please ensure a Fetch API polyfill is provided.');
    }

    const response = await fetchFn(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Basic ${this.token}`,
      },
      body: JSON.stringify({ query, variables, operationName }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Soundtrack API request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const json = (await response.json()) as GraphQLResponse<T>;

    if (json.errors && json.errors.length > 0) {
      throw new Error(json.errors.map((error) => error.message).join('; '));
    }

    if (!json.data) {
      throw new Error('Soundtrack API response missing data');
    }

    return json.data;
  }

  async listSoundZones(options?: { accountLimit?: number; zoneLimit?: number }) {
    const data = await this.execute<{ me: any }>(LIST_SOUND_ZONES, {
      accountLimit: options?.accountLimit ?? 10,
      zoneLimit: options?.zoneLimit ?? 20,
    });

    return data.me;
  }

  async getNowPlaying(soundZoneId: string): Promise<SoundtrackNowPlaying | null> {
    const data = await this.execute<{ nowPlaying: SoundtrackNowPlaying | null }>(NOW_PLAYING_QUERY, {
      soundZone: soundZoneId,
    });

    return data.nowPlaying ?? null;
  }

  async setSoundZoneContent(soundZoneId: string, contentId: string) {
    await this.execute(SET_CONTENT_MUTATION, {
      soundZone: soundZoneId,
      content: contentId,
    });
  }

  async play(soundZoneId: string) {
    await this.execute(PLAY_MUTATION, { soundZone: soundZoneId });
  }

  async pause(soundZoneId: string) {
    await this.execute(PAUSE_MUTATION, { soundZone: soundZoneId });
  }

  async skipToNext(soundZoneId: string) {
    await this.execute(SKIP_MUTATION, { soundZone: soundZoneId });
  }

  async search(query: string, limit = 20): Promise<SoundtrackSearchResult[]> {
    const data = await this.execute<{ search: { edges: Array<{ node: any }> } }>(SEARCH_CONTENT_QUERY, {
      query,
      limit,
    });

    return (data.search?.edges ?? []).map((edge) => {
      const node = edge.node;

      if (!node) {
        return {
          type: 'unknown' as const,
          id: '',
          name: query,
        };
      }

      if (node.__typename === 'TrackSearchResult') {
        const track = node.track;
        return {
          type: 'track' as const,
          id: track.id,
          name: track.name,
          durationMs: track.durationMs ?? null,
          artists: (track.artists ?? []).map((artist: { name: string }) => artist.name),
          imageUrl: track.album?.image?.url ?? null,
        } satisfies SoundtrackSearchResult;
      }

      if (node.__typename === 'PlaylistSearchResult') {
        const playlist = node.playlist;
        return {
          type: 'playlist' as const,
          id: playlist.id,
          name: playlist.name,
          description: playlist.description ?? null,
          imageUrl: playlist.image?.url ?? null,
        } satisfies SoundtrackSearchResult;
      }

      return {
        type: 'unknown' as const,
        id: node.id ?? query,
        name: node.name ?? query,
      } satisfies SoundtrackSearchResult;
    });
  }
}

export const soundtrackService = new SoundtrackService();
