"use client";

import { Component, type ReactNode } from "react";

// A chart failure must not take the balances or navigation down with it.
export class PanelBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="grid min-h-48 place-items-center rounded-lg border bg-card p-6 text-center">
        <div>
          <p>This panel could not load</p>
          <button type="button" className="mt-4 rounded-md border px-4 py-2" onClick={() => this.setState({ failed: false })}>Try again</button>
        </div>
      </div>
    );
  }
}
