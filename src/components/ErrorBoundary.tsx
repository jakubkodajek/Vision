import { Component, type ErrorInfo, type ReactNode } from "react";
import { ErrorState } from "./primitives";

interface ErrorBoundaryState {
  error: Error | null;
}

/** Catches render errors so one broken view does not blank the whole window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Local log only; Vision has no telemetry.
    console.error("Vision UI error", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="fatal-error">
          <ErrorState
            title="Something went wrong in the Vision window"
            message="Your runs keep going in the core. Reload the window to continue."
            onRetry={() => {
              this.setState({ error: null });
            }}
          />
        </div>
      );
    }
    return this.props.children;
  }
}
