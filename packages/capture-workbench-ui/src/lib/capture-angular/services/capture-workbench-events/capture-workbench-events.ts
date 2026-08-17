import { Injectable } from '@angular/core';
import type {
  CaptureCompletedEvent,
  CaptureFailedEvent,
  CaptureTaskView,
} from '../../../contracts';

export const CAPTURE_WORKBENCH_CUSTOM_EVENTS = Object.freeze({
  reviewRequired: 'capture-review-required',
  completed: 'capture-completed',
  failed: 'capture-failed',
  canceled: 'capture-canceled',
  taskChanged: 'capture-task-changed',
} as const);

export type CaptureWorkbenchCustomEventName =
  (typeof CAPTURE_WORKBENCH_CUSTOM_EVENTS)[keyof typeof CAPTURE_WORKBENCH_CUSTOM_EVENTS];

export type CaptureWorkbenchCustomEventDetail =
  | CaptureCompletedEvent
  | CaptureFailedEvent
  | CaptureTaskView;

@Injectable({ providedIn: 'root' })
export class CaptureWorkbenchEventFactory {
  create<T extends CaptureWorkbenchCustomEventDetail>(
    type: CaptureWorkbenchCustomEventName,
    detail: T,
  ): CustomEvent<T> {
    return new CustomEvent(type, { detail, bubbles: true, composed: true });
  }
}

const publicEventFactory = new CaptureWorkbenchEventFactory();

export function createCaptureWorkbenchCustomEvent<
  T extends CaptureWorkbenchCustomEventDetail,
>(type: CaptureWorkbenchCustomEventName, detail: T): CustomEvent<T> {
  return publicEventFactory.create(type, detail);
}
