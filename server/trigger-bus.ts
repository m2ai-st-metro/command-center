/**
 * Trigger event bus (026).
 *
 * In-process pub/sub. Emit sites live in mission-dispatcher.ts, scheduler.ts,
 * and trigger-poll.ts. The evaluator subscribes and matches against enabled
 * triggers. Keeping this a module-level EventEmitter is fine because CMD is
 * a single-process orchestrator — no cross-process fan-out needed in v1.
 */
import { EventEmitter } from 'events';

export type TriggerEvent =
  | {
      type: 'mission_failed';
      mission_task_id: string;
      agent_id: string;
      error: string | null;
      source?: string | null;
    }
  | {
      type: 'schedule_missed';
      schedule_id: string;
      goal: string;
      expected_at: number;
      delay_seconds: number;
    }
  | {
      type: 'agent_offline';
      agent_id: string;
      duration_seconds: number;
      reason: string;
    };

export type TriggerEventType = TriggerEvent['type'];

class TriggerBus extends EventEmitter {
  emitEvent(event: TriggerEvent): void {
    // Both a generic 'event' channel (useful for audit) and the specific type.
    this.emit('event', event);
    this.emit(event.type, event);
  }
}

export const triggerBus = new TriggerBus();
triggerBus.setMaxListeners(50);
