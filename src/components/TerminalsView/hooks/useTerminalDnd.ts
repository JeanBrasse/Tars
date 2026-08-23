'use client';

import { useCallback } from 'react';
import {
  useSensor,
  useSensors,
  PointerSensor,
  type DragEndEvent,
} from '@dnd-kit/core';

interface UseTerminalDndOptions {
  onSkillDrop?: (skillName: string, agentId: string) => void;
  onAgentReorder?: (agentId: string, newIndex: number) => void;
}

// Hoisted: dnd-kit's useSensor memoizes on this exact object's identity
// (it's the whole second argument, not just activationConstraint), and a
// fresh literal here every render defeated that. That gave DndContext's
// internal context value (which every useDroppable/useDraggable in the tree
// subscribes to via useContext, bypassing React.memo entirely) a new
// identity on every agents:tick - see the comment on dropData in
// TerminalPanel.tsx for how that cascades into every panel.
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 5 } };

export function useTerminalDnd({ onSkillDrop, onAgentReorder }: UseTerminalDndOptions) {
  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS)
  );

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeData = active.data.current;
    const overData = over.data.current;

    // Skill dropped onto a terminal panel
    if (activeData?.type === 'skill' && overData?.type === 'terminal-panel') {
      onSkillDrop?.(activeData.skillName as string, overData.agentId as string);
    }

    // Agent reorder in sidebar
    if (activeData?.type === 'agent' && overData?.type === 'agent') {
      onAgentReorder?.(active.id as string, overData.index as number);
    }
  }, [onSkillDrop, onAgentReorder]);

  return {
    sensors,
    handleDragEnd,
  };
}
