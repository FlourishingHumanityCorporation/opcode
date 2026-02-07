import React, { Suspense, lazy, useEffect } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import type { UtilityOverlayType } from '@/contexts/TabContext';
import { Button } from '@/components/ui/button';
import { ClaudeFileEditor } from '@/components/ClaudeFileEditor';
import type { ClaudeMdFile } from '@/lib/api';
import { logWorkspaceEvent } from '@/services/workspaceDiagnostics';

const Agents = lazy(() => import('@/components/Agents').then((m) => ({ default: m.Agents })));
const UsageDashboard = lazy(() => import('@/components/UsageDashboard').then((m) => ({ default: m.UsageDashboard })));
const MCPManager = lazy(() => import('@/components/MCPManager').then((m) => ({ default: m.MCPManager })));
const Settings = lazy(() => import('@/components/Settings').then((m) => ({ default: m.Settings })));
const MarkdownEditor = lazy(() => import('@/components/MarkdownEditor').then((m) => ({ default: m.MarkdownEditor })));
const DiagnosticsPanel = lazy(() => import('@/components/DiagnosticsPanel').then((m) => ({ default: m.DiagnosticsPanel })));

interface UtilityOverlayHostProps {
  overlay: UtilityOverlayType;
  payload: any;
  onClose: () => void;
}

interface UtilityOverlayErrorBoundaryProps {
  children: React.ReactNode;
  overlay: UtilityOverlayType;
}

interface UtilityOverlayErrorBoundaryState {
  hasError: boolean;
}

class UtilityOverlayErrorBoundary extends React.Component<
  UtilityOverlayErrorBoundaryProps,
  UtilityOverlayErrorBoundaryState
> {
  state: UtilityOverlayErrorBoundaryState = {
    hasError: false,
  };

  static getDerivedStateFromError(): UtilityOverlayErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error): void {
    logWorkspaceEvent({
      category: 'error',
      action: 'utility_overlay_render_failed',
      message: error.message,
      payload: { overlay: this.props.overlay },
    });
  }

  componentDidUpdate(prevProps: UtilityOverlayErrorBoundaryProps): void {
    if (prevProps.overlay !== this.props.overlay && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex h-full items-center justify-center p-6">
          <div className="max-w-sm text-center">
            <p className="text-sm font-medium">Utility panel failed to render.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Open Diagnostics from the top menu to inspect logs.
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function toClaudeFile(payload: any): ClaudeMdFile | null {
  if (!payload) return null;

  if (payload.file && payload.file.path) {
    return payload.file as ClaudeMdFile;
  }

  if (payload.path) {
    return payload as ClaudeMdFile;
  }

  return null;
}

export const UtilityOverlayHost: React.FC<UtilityOverlayHostProps> = ({ overlay, payload, onClose }) => {
  const file = toClaudeFile(payload);

  useEffect(() => {
    if (!overlay) return;
    logWorkspaceEvent({
      category: 'state_action',
      action: 'utility_overlay_opened',
      payload: { overlay },
    });
  }, [overlay]);

  const renderContent = () => {
    switch (overlay) {
      case 'agents':
        return <Agents />;
      case 'usage':
        return <UsageDashboard onBack={onClose} />;
      case 'mcp':
        return <MCPManager onBack={onClose} />;
      case 'settings':
        return <Settings onBack={onClose} />;
      case 'claude-md':
        return <MarkdownEditor onBack={onClose} />;
      case 'claude-file':
        return file ? <ClaudeFileEditor file={file} onBack={onClose} /> : <MarkdownEditor onBack={onClose} />;
      case 'diagnostics':
        return <DiagnosticsPanel />;
      default:
        return null;
    }
  };

  return (
    <AnimatePresence>
      {overlay && (
        <>
          <motion.div
            className="fixed inset-0 z-40 bg-black/30"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={onClose}
          />
          <motion.aside
            className="fixed inset-y-0 right-0 z-50 w-[min(680px,58vw)] min-w-[420px] border-l border-border/70 bg-background shadow-2xl"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
          >
            <div className="flex h-11 items-center justify-between border-b border-border/60 px-3">
              <div className="text-sm font-medium capitalize">{overlay.replace('-', ' ')}</div>
              <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onClose}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="h-[calc(100%-44px)] overflow-hidden">
              <UtilityOverlayErrorBoundary overlay={overlay}>
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      Loading...
                    </div>
                  }
                >
                  {renderContent()}
                </Suspense>
              </UtilityOverlayErrorBoundary>
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
};

export default UtilityOverlayHost;
