import { act, render, screen, within } from "@testing-library/react";
import { vi } from "vitest";
import App from "../../src/App";
import type { FakeClient } from "./fakeClient";

/** Renders the shipped app with a fake IPC client. */
export function renderApp(fake: FakeClient) {
  return render(<App client={fake} />);
}

/** Lets pending promises (fake client answers) settle while fake timers are installed. */
export async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Clicks a sidebar navigation entry. */
export function nav(name: string): HTMLElement {
  return within(screen.getByRole("navigation", { name: "Sidebar" })).getByRole("button", { name });
}

/** The card (article) of a tool or server by its heading. */
export function card(name: string): HTMLElement {
  return screen.getByRole("article", { name });
}

/** Finds the card (article) of a tool or server by its heading, waiting for it. */
export function findCard(name: string): Promise<HTMLElement> {
  return screen.findByRole("article", { name });
}

/**
 * Awaits a query, then lets React run the effects of the render that produced it (an answer
 * from the fake client renders outside `act`, so listeners attach a moment after the DOM).
 */
export async function settled<T>(query: Promise<T>): Promise<T> {
  const value = await query;
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return value;
}
