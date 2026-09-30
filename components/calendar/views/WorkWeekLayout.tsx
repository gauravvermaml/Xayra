import type { DateRange } from "../../../services/calendar/dateRange";
import type { ToDo } from "../../../services/todos/todoManager";
import { WeekGridLayout } from "./WeekGridLayout";

export type WorkWeekLayoutProps = {
  range: DateRange;
  todos: ToDo[];
  onOpenTask: (item: ToDo) => void;
  onCheckTask: (item: ToDo) => void;
  onLongPressDelete: (item: ToDo) => void;
  initialScrollY?: number | null;
  onScrollYChange?: (y: number) => void;
};

/** Mon-Fri, 5 columns — see WeekGridLayout.tsx for the shared implementation
 * (identical to WeekLayout.tsx's own besides day count). */
export function WorkWeekLayout(props: WorkWeekLayoutProps) {
  return <WeekGridLayout {...props} />;
}
