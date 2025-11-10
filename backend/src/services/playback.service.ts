import { Server as SocketIOServer } from 'socket.io';
import { queueService } from './queue.service';
import { soundtrackService, SoundtrackNowPlaying } from './soundtrack.service';
import { broadcastQueueUpdate, broadcastPlaybackUpdate } from '../sockets/handlers';
import { config } from '../config';

interface MonitorState {
  hostId: string;
  soundZoneId: string | null;
  timeout: NodeJS.Timeout | null;
  processing: boolean;
  currentTrackId: string | null;
  awaitingTrackId: string | null;
  requestIssuedAt: number | null;
}

const DEFAULT_POLL_INTERVAL_MS = 5000;
const MIN_POLL_INTERVAL_MS = 2000;
const CONTENT_REQUEST_TIMEOUT_MS = 15000;

const enum SoundtrackPlaybackState {
  Playing = 'PLAYING',
  Paused = 'PAUSED',
}

export interface PlaybackTrackPayload {
  id: string;
  name: string;
  durationMs: number | null;
  artists: string[];
  album: {
    name: string | null;
    imageUrl: string | null;
  };
}

export interface PlaybackPayload {
  isPlaying: boolean;
  progressMs: number | null;
  startedAt: string | null;
  track: PlaybackTrackPayload | null;
}

function computeProgressMs(nowPlaying: SoundtrackNowPlaying | null): number | null {
  if (!nowPlaying?.startedAt) {
    return null;
  }

  const startedAtMs = Date.parse(nowPlaying.startedAt);

  if (Number.isNaN(startedAtMs)) {
    return null;
  }

  const progress = Date.now() - startedAtMs;

  if (progress < 0) {
    return 0;
  }

  const duration = nowPlaying.track?.durationMs ?? null;

  if (typeof duration === 'number' && duration > 0) {
    return Math.min(progress, duration);
  }

  return progress;
}

export function buildPlaybackPayload(nowPlaying: SoundtrackNowPlaying | null): PlaybackPayload | null {
  if (!nowPlaying) {
    return null;
  }

  const progressMs = computeProgressMs(nowPlaying);

  if (!nowPlaying.track) {
    return {
      isPlaying: nowPlaying.state === SoundtrackPlaybackState.Playing,
      progressMs,
      startedAt: nowPlaying.startedAt,
      track: null,
    };
  }

  const track = nowPlaying.track;

  return {
    isPlaying: nowPlaying.state === SoundtrackPlaybackState.Playing,
    progressMs,
    startedAt: nowPlaying.startedAt,
    track: {
      id: track.id,
      name: track.name,
      durationMs: track.durationMs ?? null,
      artists: (track.artists ?? []).map((artist) => artist.name),
      album: {
        name: track.album?.name ?? null,
        imageUrl: track.album?.image?.url ?? null,
      },
    },
  };
}

class PlaybackService {
  private io: SocketIOServer | null = null;
  private monitors = new Map<string, MonitorState>();

  private async resolveRequester(sessionId: string, contentId?: string | null) {
    if (!contentId) {
      return null;
    }

    const queueItem = await queueService.getMostRecentQueueItemForTrack(sessionId, contentId);

    if (!queueItem) {
      return null;
    }

    if (queueItem.addedBy) {
      return {
        type: 'host' as const,
        name: queueItem.addedBy.displayName,
      };
    }

    if (queueItem.addedByGuest) {
      return {
        type: 'guest' as const,
        name: queueItem.addedByGuest.name,
      };
    }

    return {
      type: 'unknown' as const,
      name: 'Unknown',
    };
  }

  private derivePollDelay(nowPlaying: SoundtrackNowPlaying | null): number {
    const progress = computeProgressMs(nowPlaying);
    const duration = nowPlaying?.track?.durationMs ?? null;

    if (nowPlaying?.state === SoundtrackPlaybackState.Playing && progress !== null && typeof duration === 'number' && duration > 0) {
      const remaining = Math.max(0, duration - progress);
      const bufferMs = 2500;
      return Math.max(MIN_POLL_INTERVAL_MS, Math.min(DEFAULT_POLL_INTERVAL_MS, remaining + bufferMs));
    }

    return DEFAULT_POLL_INTERVAL_MS;
  }

  setSocketServer(io: SocketIOServer) {
    this.io = io;
  }

  ensureMonitor(sessionId: string, hostId: string, soundZoneId: string | null) {
    const existing = this.monitors.get(sessionId);

    if (existing) {
      existing.hostId = hostId;
      existing.soundZoneId = soundZoneId ?? existing.soundZoneId ?? null;
      if (!existing.timeout && !existing.processing) {
        this.schedulePoll(sessionId, 0);
      }
      return;
    }

    this.monitors.set(sessionId, {
      hostId,
      soundZoneId: soundZoneId ?? config.soundtrack.defaultSoundZone ?? null,
      timeout: null,
      processing: false,
      currentTrackId: null,
      awaitingTrackId: null,
      requestIssuedAt: null,
    });

    this.schedulePoll(sessionId, 0);
  }

  updateSoundZone(sessionId: string, soundZoneId: string | null) {
    const monitor = this.monitors.get(sessionId);

    if (!monitor) {
      return;
    }

    monitor.soundZoneId = soundZoneId;
    this.requestImmediateSync(sessionId, 0);
  }

  stopMonitor(sessionId: string) {
    const monitor = this.monitors.get(sessionId);

    if (monitor) {
      if (monitor.timeout) {
        clearTimeout(monitor.timeout);
      }
      this.monitors.delete(sessionId);
    }
  }

  requestImmediateSync(sessionId: string, delayMs = 0) {
    const monitor = this.monitors.get(sessionId);

    if (!monitor) {
      return;
    }

    if (monitor.processing) {
      return;
    }

    this.schedulePoll(sessionId, delayMs);
  }

  private schedulePoll(sessionId: string, delayMs: number) {
    const monitor = this.monitors.get(sessionId);

    if (!monitor) {
      return;
    }

    if (monitor.timeout) {
      clearTimeout(monitor.timeout);
    }

    monitor.timeout = setTimeout(() => {
      monitor.timeout = null;
      this.pollSession(sessionId).catch((error) => {
        console.error(`Playback poll error for session ${sessionId}:`, error);
      });
    }, Math.max(0, delayMs));
  }

  private async pollSession(sessionId: string) {
    const monitor = this.monitors.get(sessionId);

    if (!monitor || monitor.processing) {
      return;
    }

    if (!this.io) {
      return;
    }

    if (!monitor.soundZoneId) {
      console.warn(`No Soundtrack zone configured for session ${sessionId}. Playback monitoring paused.`);
      this.schedulePoll(sessionId, DEFAULT_POLL_INTERVAL_MS);
      return;
    }

    monitor.processing = true;

    try {
      const nowPlaying = await soundtrackService.getNowPlaying(monitor.soundZoneId);
      let queueState = await queueService.getQueueWithNext(sessionId);

      const currentTrackId = nowPlaying?.track?.id ?? null;

      if (monitor.awaitingTrackId && monitor.awaitingTrackId === currentTrackId) {
        monitor.currentTrackId = monitor.awaitingTrackId;
        monitor.awaitingTrackId = null;
        monitor.requestIssuedAt = null;
      }

      if (monitor.currentTrackId && monitor.currentTrackId !== currentTrackId) {
        const consumed = await queueService.markTrackAsPlayed(sessionId, monitor.currentTrackId);
        if (consumed) {
          queueState = await queueService.getQueueWithNext(sessionId);
        }
        monitor.currentTrackId = currentTrackId;
      } else if (!monitor.currentTrackId) {
        monitor.currentTrackId = currentTrackId;
      }

      const nextUp = queueState.nextUp ?? null;

      const shouldRetryContentRequest = monitor.awaitingTrackId
        && (!currentTrackId || currentTrackId !== monitor.awaitingTrackId)
        && (monitor.requestIssuedAt !== null && Date.now() - monitor.requestIssuedAt > CONTENT_REQUEST_TIMEOUT_MS);

      if (shouldRetryContentRequest) {
        try {
          await soundtrackService.setSoundZoneContent(monitor.soundZoneId, monitor.awaitingTrackId!);
          await soundtrackService.play(monitor.soundZoneId);
          monitor.requestIssuedAt = Date.now();
        } catch (error) {
          console.error('Failed to retry Soundtrack content assignment:', error);
        }
      }

      if (nextUp && nextUp.spotifyTrackId) {
        const needsAssignment = currentTrackId !== nextUp.spotifyTrackId && monitor.awaitingTrackId !== nextUp.spotifyTrackId;

        if (needsAssignment) {
          try {
            await soundtrackService.setSoundZoneContent(monitor.soundZoneId, nextUp.spotifyTrackId);
            await soundtrackService.play(monitor.soundZoneId);
            monitor.awaitingTrackId = nextUp.spotifyTrackId;
            monitor.requestIssuedAt = Date.now();
          } catch (error) {
            console.error('Failed to assign Soundtrack content for next track:', error);
          }
        }
      } else if (!nextUp && !currentTrackId && config.soundtrack.defaultContentId) {
        const shouldFallback = monitor.awaitingTrackId !== config.soundtrack.defaultContentId;
        if (shouldFallback) {
          try {
            await soundtrackService.setSoundZoneContent(monitor.soundZoneId, config.soundtrack.defaultContentId);
            await soundtrackService.play(monitor.soundZoneId);
            monitor.awaitingTrackId = config.soundtrack.defaultContentId;
            monitor.requestIssuedAt = Date.now();
          } catch (error) {
            console.error('Failed to resume default Soundtrack content:', error);
          }
        }
      }

      const requester = await this.resolveRequester(sessionId, currentTrackId);
  const playbackPayload = buildPlaybackPayload(nowPlaying);

      broadcastQueueUpdate(this.io, sessionId, queueState);
      broadcastPlaybackUpdate(this.io, sessionId, {
        playback: playbackPayload,
        requester,
      });

      const nextDelay = this.derivePollDelay(nowPlaying);
      this.schedulePoll(sessionId, nextDelay);
    } catch (error) {
      console.error(`Playback sync error for session ${sessionId}:`, error);
      this.schedulePoll(sessionId, DEFAULT_POLL_INTERVAL_MS);
    } finally {
      monitor.processing = false;
    }
  }
}

export const playbackService = new PlaybackService();
