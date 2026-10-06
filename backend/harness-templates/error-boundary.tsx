/** @jsxRuntime automatic */
/*
 * PRVision render harness error boundary (static template, sheet 10).
 * Reports the first render error (with React's component stack) to the entry, then shows a visible marker.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface PrvisionErrorBoundaryProps {
  children?: ReactNode;
  onError: (error: unknown, componentStack: string | null) => void;
}

interface PrvisionErrorBoundaryState {
  hasError: boolean;
  error: unknown;
}

export class PrvisionErrorBoundary extends Component<PrvisionErrorBoundaryProps, PrvisionErrorBoundaryState> {
  state: PrvisionErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: unknown): PrvisionErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError(error, info.componentStack ?? null);
  }

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }
    const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error);
    return (
      <pre
        data-prvision-error=""
        style={{
          margin: 0,
          padding: 12,
          font: "12px/1.4 monospace",
          color: "#b00020",
          background: "#fff0f0",
          whiteSpace: "pre-wrap",
        }}
      >
        {message}
      </pre>
    );
  }
}
