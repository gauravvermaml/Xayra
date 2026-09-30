import type { DateRange } from "../../../services/calendar/dateRange";
import type { ToDo } from "../../../services/todos/todoManager";
import { WeekGridLayout } from "./WeekGridLayout";

export type WeekLayoutProps = {
  range: DateRange;
  todos: ToDo[];
  onOpenTask: (item: ToDo) => void;
  onCheckTask: (item: ToDo) => void;
  onLongPressDelete: (item: ToDo) => void;
  initialScrollY?: number | null;
  onScrollYChange?: (y: number) => void;
};

/** Sun-Sat, 7 columns — see WeekGridLayout.tsx for the shared implementation
 * (identical to WorkWeekLayout.tsx's own besides day count). */
export function WeekLayout(props: WeekLayoutProps) {
  return <WeekGridLayout {...props} />;
}
