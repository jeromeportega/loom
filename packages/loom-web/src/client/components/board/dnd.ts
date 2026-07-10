import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { FleetCard } from '../../../shared/fleet';
import { dropActions, type LaneId } from './laneModel';

export { draggable, dropTargetForElements, monitorForElements };

export const CARD_DRAG_TYPE = 'loom-epic-card';

export type CardDragData = {
  [key: string]: unknown;
  type: typeof CARD_DRAG_TYPE;
  card: FleetCard;
};

export function isCardDrag(data: Record<string | symbol, unknown>): data is CardDragData {
  return data.type === CARD_DRAG_TYPE;
}

export type LaneDropData = {
  [key: string]: unknown;
  laneId: LaneId;
};

/** True when a dragged (planned) card may be dropped on this lane. */
export function laneAcceptsCard(laneId: LaneId, card: FleetCard): boolean {
  return laneId in dropActions(card);
}
