import { Loader2 } from 'lucide-react';
import type { WorkspaceStatus } from '@/contexts/TabContext';

export type TabStatusIndicatorKind =
  | 'running'
  | 'needs_response'
  | 'needs_check'
  | 'error';

export interface TabStatusIndicator {
  kind: TabStatusIndicatorKind;
  label: 'In progress' | 'Needs response' | 'Needs check' | 'Error';
}

export function getStatusIndicator(
  status: WorkspaceStatus
): TabStatusIndicator | null {
  switch (status) {
    case 'running':
      return { kind: 'running', label: 'In progress' };
    case 'attention':
      return { kind: 'needs_response', label: 'Needs response' };
    case 'complete':
      return { kind: 'needs_check', label: 'Needs check' };
    case 'error':
      return { kind: 'error', label: 'Error' };
    default:
      return null;
  }
}

export function renderTabStatusMarker(
  indicator: TabStatusIndicator
): JSX.Element {
  switch (indicator.kind) {
    case 'running':
      return (
        <span
          className="flex h-3.5 w-3.5 items-center justify-center text-emerald-500"
          title={indicator.label}
          aria-label={indicator.label}
        >
          <Loader2 className="h-3 w-3 animate-spin" />
        </span>
      );
    case 'needs_response':
      return (
        <span
          className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-500 text-[9px] font-bold leading-none text-white"
          title={indicator.label}
          aria-label={indicator.label}
        >
          ?
        </span>
      );
    case 'needs_check':
      return (
        <span
          className="h-3 w-3 rounded-full bg-sky-500"
          title={indicator.label}
          aria-label={indicator.label}
        />
      );
    case 'error':
      return (
        <span
          className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-rose-500 text-[9px] font-bold leading-none text-white"
          title={indicator.label}
          aria-label={indicator.label}
        >
          !
        </span>
      );
  }
}
