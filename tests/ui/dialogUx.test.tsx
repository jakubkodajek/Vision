import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "../../src/components/Dialog";
import { findCard, renderApp, settled } from "./appHarness";
import { standardFake, type FakeClient } from "./fakeClient";

beforeEach(() => {
  window.localStorage.clear();
});

function Harness({ onClose }: { onClose: () => void }) {
  const [busy] = useState(true);
  return (
    <>
      <button type="button">Outside</button>
      <Dialog title="Test dialog" onClose={onClose}>
        <button type="button">First</button>
        <fieldset disabled={busy}>
          <button type="button">Inside disabled fieldset</button>
        </fieldset>
        <button type="button" disabled>
          Disabled
        </button>
      </Dialog>
    </>
  );
}

describe("dialog keyboard handling (UX-1, CR-15)", () => {
  it("skips_controls_disabled_through_a_fieldset_when_tabbing", () => {
    render(<Harness onClose={() => undefined} />);
    const dialog = screen.getByRole("dialog");
    within(dialog).getByRole("button", { name: "First" }).focus();
    // "First" is the last control Tab can reach, so Tab wraps to the Close button.
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab" });
    expect(within(dialog).getByRole("button", { name: "Close" })).toHaveFocus();
  });

  it("closes_on_escape_even_when_focus_fell_to_the_page", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("pulls_focus_back_when_it_moves_behind_the_dialog", () => {
    render(<Harness onClose={() => undefined} />);
    screen.getByRole("button", { name: "Outside", hidden: true }).focus();
    expect(screen.getByRole("dialog")).toHaveFocus();
  });

  it("moves_tab_back_into_the_dialog_when_focus_is_on_the_page", () => {
    render(<Harness onClose={() => undefined} />);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "Tab" });
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" })).toHaveFocus();
  });
});

async function openAddTool(fake: FakeClient): Promise<HTMLElement> {
  renderApp(fake);
  fireEvent.click(await settled(screen.findByRole("button", { name: "Tools" })));
  await settled(findCard("GitHub CLI"));
  fireEvent.click(screen.getByRole("button", { name: "Add custom tool" }));
  return screen.getByRole("dialog", { name: "Add custom tool" });
}

describe("form dialogs", () => {
  it("focuses_the_first_invalid_field_after_a_failed_submit", async () => {
    const dialog = await openAddTool(standardFake());
    fireEvent.click(within(dialog).getByRole("button", { name: "Add tool" }));
    expect(within(dialog).getByLabelText("Name")).toHaveFocus();
  });

  it("summarises_how_many_fields_need_attention", async () => {
    const dialog = await openAddTool(standardFake());
    fireEvent.click(within(dialog).getByRole("button", { name: "Add tool" }));
    expect(within(dialog).getByRole("status")).toHaveTextContent("5 fields need attention.");
  });

  it("focuses_the_field_a_core_error_names", async () => {
    const fake = standardFake();
    const dialog = await openAddTool(fake);
    fake.fail(
      "customToolSave",
      "invalid_input",
      "This config variable is used by the system.",
      false,
      "config_var",
    );
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "My Tool" },
    });
    fireEvent.change(within(dialog).getByLabelText("Program"), {
      target: { value: "mytool" },
    });
    fireEvent.change(within(dialog).getByLabelText("Config variable"), {
      target: { value: "MYTOOL_HOME" },
    });
    fireEvent.change(within(dialog).getByLabelText("Sign-in arguments"), {
      target: { value: "login" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add tool" }));
    await settled(within(dialog).findByText("This config variable is used by the system."));
    expect(within(dialog).getByLabelText("Config variable")).toHaveFocus();
  });

  it("shows_a_core_error_without_a_field_for_the_whole_form", async () => {
    const fake = standardFake();
    const dialog = await openAddTool(fake);
    fake.fail("customToolSave", "io", "Disk full");
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "My Tool" },
    });
    fireEvent.change(within(dialog).getByLabelText("Program"), {
      target: { value: "mytool" },
    });
    fireEvent.change(within(dialog).getByLabelText("Config variable"), {
      target: { value: "MYTOOL_HOME" },
    });
    fireEvent.change(within(dialog).getByLabelText("Sign-in arguments"), {
      target: { value: "login" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add tool" }));
    expect(await settled(within(dialog).findByText(/Disk full/))).toBeInTheDocument();
  });

  it("keeps_fields_focusable_but_read_only_while_saving", async () => {
    const fake = standardFake().hold("customToolSave");
    const dialog = await openAddTool(fake);
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "My Tool" },
    });
    fireEvent.change(within(dialog).getByLabelText("Program"), {
      target: { value: "mytool" },
    });
    fireEvent.change(within(dialog).getByLabelText("Config variable"), {
      target: { value: "MYTOOL_HOME" },
    });
    fireEvent.change(within(dialog).getByLabelText("Sign-in arguments"), {
      target: { value: "login" },
    });
    const name = within(dialog).getByLabelText("Name");
    name.focus();
    fireEvent.submit(name.closest("form") as HTMLFormElement);
    await settled(Promise.resolve());
    expect(name).not.toBeDisabled();
    expect(name).toHaveAttribute("readonly");
    expect(name).toHaveFocus();
  });

  it("does_not_add_a_tool_before_the_tool_list_is_loaded", async () => {
    const fake = standardFake().hold("toolsList");
    renderApp(fake);
    fireEvent.click(await settled(screen.findByRole("button", { name: "Tools" })));
    fireEvent.click(screen.getByRole("button", { name: "Add custom tool" }));
    const dialog = screen.getByRole("dialog", { name: "Add custom tool" });
    expect(within(dialog).getByRole("button", { name: "Add tool" })).toHaveAttribute("aria-disabled", "true");
  });

  it("closes_a_pristine_form_on_escape_without_asking", async () => {
    await openAddTool(standardFake());
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("asks_before_discarding_changes", async () => {
    const dialog = await openAddTool(standardFake());
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "My Tool" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    const ask = screen.getByRole("alertdialog", { name: "Discard changes?" });
    expect(within(ask).getByRole("button", { name: "Keep editing" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(screen.getByRole("dialog", { name: "Add custom tool" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Name")).toHaveValue("My Tool");
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Discard",
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
