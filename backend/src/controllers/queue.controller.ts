import { Request, Response } from 'express';
import { queueService } from '../services/queue.service';
import { sessionService } from '../services/session.service';
import { playbackService } from '../services/playback.service';
import { broadcastQueueUpdate } from '../sockets/handlers';
import { Server as SocketIOServer } from 'socket.io';
import { creditService, CreditError, CreditState, GUEST_TRACK_COST, VOTE_REACTION_COST } from '../services/credit.service';
import { config } from '../config';

export class QueueController {
  private resolveSessionActor = async (req: Request, sessionId: string) => {
    const session = await sessionService.getSession(sessionId);

    if (!session || !session.isActive) {
      return { error: 'Session not found or inactive' } as const;
    }

    const isHost = req.session.userId === session.hostId;
    const guestData = req.session.guestSessions?.[sessionId];
    let guestId: string | undefined;

    if (!isHost) {
      if (!guestData) {
        return { error: 'Join the session before interacting with the queue' } as const;
      }

      const guest = await sessionService.getGuestById(guestData.guestId);

      if (!guest || guest.sessionId !== sessionId) {
        if (req.session.guestSessions) {
          delete req.session.guestSessions[sessionId];
        }
        return { error: 'Join the session before interacting with the queue' } as const;
      }

      guestId = guest.id;
    }

    if (!isHost && !guestId) {
      return { error: 'Join the session before interacting with the queue' } as const;
    }

    const actor = isHost
      ? { userId: session.hostId }
      : { guestId: guestId! };

    const soundZoneId = session.soundtrackZoneId || config.soundtrack.defaultSoundZone;

    return {
      session,
      actor,
      role: isHost ? 'host' as const : 'guest' as const,
      soundZoneId: soundZoneId ?? null,
    } as const;
  };

  private async emitQueueState(req: Request, sessionId: string) {
    const state = await queueService.getQueueWithNext(sessionId);
    const io = req.app.get('io') as SocketIOServer | undefined;

    if (io) {
      broadcastQueueUpdate(io, sessionId, state);
    }

    return state;
  }

  add = async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      const { content } = req.body ?? {};

      if (!content || typeof content !== 'object') {
        return res.status(400).json({ error: 'Track content is required' });
      }

      const {
        id: trackId,
        name,
        artists,
        album,
        imageUrl,
        durationMs,
        explicit,
      } = content as {
        id?: string;
        name?: string;
        artists?: string[];
        album?: string | null;
        imageUrl?: string | null;
        durationMs?: number | null;
        explicit?: boolean;
      };

      if (!trackId || !name) {
        return res.status(400).json({ error: 'Track id and name are required' });
      }

      if ((req as any)._spentCreditsForQueue) {
        delete (req as any)._spentCreditsForQueue;
      }

      const context = await this.resolveSessionActor(req, sessionId);

      if ('error' in context) {
        return res.status(context.error === 'Session not found or inactive' ? 404 : 401)
          .json({ error: context.error });
      }

    const { session, actor, role, soundZoneId } = context;
    const allowExplicit = session.allowExplicit ?? true;
      const clerkUserId = req.auth?.userId ?? null;
      let guestCreditState: CreditState | null = null;

      playbackService.ensureMonitor(sessionId, session.hostId, soundZoneId);

      if (!allowExplicit && explicit) {
        return res.status(400).json({ error: 'Explicit tracks are disabled for this session' });
      }

      if (role === 'guest') {
        if (!clerkUserId) {
          return res.status(401).json({ error: 'Not authenticated' });
        }

        try {
          guestCreditState = await creditService.spendCredits(clerkUserId, GUEST_TRACK_COST);
          (req as any)._spentCreditsForQueue = {
            amount: GUEST_TRACK_COST,
            clerkUserId,
          };
        } catch (error) {
          if (error instanceof CreditError) {
            return res.status(error.status).json({ error: error.message });
          }
          throw error;
        }
      }

      // Add to queue
      const queueItem = await queueService.addToQueue(
        sessionId,
        trackId,
        name,
        (artists ?? []).join(', '),
        album ?? null,
        imageUrl ?? null,
        typeof durationMs === 'number' ? durationMs : 0,
        actor
      );

      const state = await this.emitQueueState(req, sessionId);

      playbackService.requestImmediateSync(sessionId);

      const payload: Record<string, unknown> = {
        queueItem,
        role,
        nextUp: state.nextUp,
        queue: state.queue,
      };

      if (guestCreditState) {
        payload.credits = guestCreditState;
      }

      if ((req as any)._spentCreditsForQueue) {
        delete (req as any)._spentCreditsForQueue;
      }

      res.json(payload);
    } catch (error: any) {
      console.error('Add to queue error:', error);

      if (error instanceof CreditError) {
        return res.status(error.status).json({ error: error.message });
      }

      const spentInfo = (req as any)._spentCreditsForQueue as { amount: number; clerkUserId: string } | undefined;
      if (spentInfo) {
        try {
          await creditService.addCredits(spentInfo.clerkUserId, spentInfo.amount);
        } catch (refundError) {
          console.error('Failed to refund credits after queue error:', refundError);
        } finally {
          delete (req as any)._spentCreditsForQueue;
        }
      }

      res.status(error.message === 'Track already in queue' ? 400 : 500)
        .json({ error: error.message || 'Failed to add to queue' });
    }
  };

  get = async (req: Request, res: Response) => {
    try {
      const { sessionId } = req.params;
      const session = await sessionService.getSession(sessionId);
      if (session?.isActive) {
        const zoneId = session.soundtrackZoneId || config.soundtrack.defaultSoundZone;
        playbackService.ensureMonitor(sessionId, session.hostId, zoneId ?? null);
      }
      const state = await queueService.getQueueWithNext(sessionId);
      res.json(state);
    } catch (error) {
      console.error('Get queue error:', error);
      res.status(500).json({ error: 'Failed to get queue' });
    }
  };

  remove = async (req: Request, res: Response) => {
    try {
      const { queueItemId } = req.params;

      const queueItem = await queueService.getQueueItemWithSession(queueItemId);

      if (!queueItem) {
        return res.status(404).json({ error: 'Queue item not found' });
      }

      const context = await this.resolveSessionActor(req, queueItem.sessionId);

      if ('error' in context) {
        return res.status(context.error === 'Session not found or inactive' ? 404 : 403)
          .json({ error: context.error });
      }

      await queueService.removeFromQueue(queueItemId, context.actor);

      const queueItemData = queueItem as any;
      let actorCredits: CreditState | null = null;
      const removingClerkUserId = req.auth?.userId;
      let guestClerkUserId = queueItemData.addedByGuest?.clerkUserId ?? null;

      if (!guestClerkUserId && queueItem.addedByGuestId) {
        try {
          const guestRecord = await sessionService.getGuestById(queueItem.addedByGuestId);
          guestClerkUserId = guestRecord?.clerkUserId ?? null;
        } catch (lookupError) {
          console.error('Failed to resolve guest Clerk ID for refund:', lookupError);
        }
      }

      if (guestClerkUserId) {
        try {
          const credits = await creditService.addCredits(guestClerkUserId, GUEST_TRACK_COST);
          if (removingClerkUserId && removingClerkUserId === guestClerkUserId) {
            actorCredits = credits;
          }
        } catch (refundError) {
          console.error('Failed to refund credits after queue removal:', refundError);
        }
      }

      if (queueItem.session.isActive) {
        const zoneId = queueItem.session.soundtrackZoneId || config.soundtrack.defaultSoundZone;
        playbackService.ensureMonitor(queueItem.sessionId, queueItem.session.hostId, zoneId ?? null);
      }
      const state = await this.emitQueueState(req, queueItem.sessionId);
      playbackService.requestImmediateSync(queueItem.sessionId);
      const payload: Record<string, unknown> = {
        message: 'Removed from queue',
        nextUp: state.nextUp,
        queue: state.queue,
      };

      if (actorCredits) {
        payload.credits = actorCredits;
      }

      res.json(payload);
    } catch (error: any) {
      console.error('Remove from queue error:', error);
      res.status(error.message === 'Not authorized to remove this track' ? 403 : 500)
        .json({ error: error.message || 'Failed to remove from queue' });
    }
  };

  vote = async (req: Request, res: Response) => {
    let spentVoteCredits: { amount: number; clerkUserId: string } | null = null;

    try {
      const { queueItemId } = req.params;
      const { voteType } = req.body;

      if (voteType !== 1 && voteType !== -1) {
        return res.status(400).json({ error: 'Vote type must be 1 or -1' });
      }

      const queueItem = await queueService.getQueueItemWithSession(queueItemId);

      if (!queueItem) {
        return res.status(404).json({ error: 'Queue item not found' });
      }

      const context = await this.resolveSessionActor(req, queueItem.sessionId);

      if ('error' in context) {
        return res.status(context.error === 'Session not found or inactive' ? 404 : 401)
          .json({ error: context.error });
      }

      const { actor, role } = context;

      let clerkUserId: string | null = null;
      let actorCredits: CreditState | null = null;

      if (role === 'host') {
        clerkUserId = req.auth?.userId ?? null;
      } else if (role === 'guest' && actor.guestId) {
        const guest = await sessionService.getGuestById(actor.guestId);
        clerkUserId = guest?.clerkUserId ?? null;
      }

      const result = await queueService.vote(queueItemId, actor, voteType, {
        beforeChange: async (intent) => {
          if (!clerkUserId || intent.action !== 'add') {
            return;
          }

          const credits = await creditService.spendCredits(clerkUserId, VOTE_REACTION_COST);
          spentVoteCredits = { amount: VOTE_REACTION_COST, clerkUserId };

          if (clerkUserId === req.auth?.userId) {
            actorCredits = credits;
          }
        },
      });

      if (result.action === 'removed' && clerkUserId) {
        const credits = await creditService.addCredits(clerkUserId, VOTE_REACTION_COST);
        if (clerkUserId === req.auth?.userId) {
          actorCredits = credits;
        }
      }

      spentVoteCredits = null;

      const state = await this.emitQueueState(req, queueItem.sessionId);
      playbackService.requestImmediateSync(queueItem.sessionId);

      const payload: Record<string, unknown> = {
        ...result,
        nextUp: state.nextUp,
        queue: state.queue,
      };

      if (actorCredits) {
        payload.credits = actorCredits;
      }

      res.json(payload);
    } catch (error) {
      console.error('Vote error:', error);

      if (spentVoteCredits) {
        const { clerkUserId: refundUserId, amount } = spentVoteCredits;
        try {
          await creditService.addCredits(refundUserId, amount);
        } catch (refundError) {
          console.error('Failed to refund vote credits after error:', refundError);
        }
        spentVoteCredits = null;
      }

      if (error instanceof CreditError) {
        return res.status(error.status).json({ error: error.message });
      }

      res.status(500).json({ error: 'Failed to vote' });
    }
  };
}

export const queueController = new QueueController();
