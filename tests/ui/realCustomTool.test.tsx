import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { card, findCard, renderApp, settled } from "./appHarness";
import { standardFake, toolSpec, toolView, type FakeClient } from "./fakeClient";

beforeEach(() => {
  window.localStorage.clear();
});

async function openDialog(fake: FakeClient): Promise<HTMLElement> {
  renderApp(fake);
  fireEvent.click(await settled(screen.findByRole("button", { name: "Tools" })));
  await settled(findCard("GitHub CLI"));
  fireEvent.click(screen.getByRole("button", { name: "Add custom tool" }));
  return screen.getByRole("dialog", { name: "Add custom tool" });
}

function fillValid(dialog: HTMLElement): void {
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "My Tool" } });
  fireEvent.change(within(dialog).getByLabelText("Program"), { target: { value: "mytool" } });
  fireEvent.change(within(dialog).getByLabelText("Config variable"), { target: { value: "MYTOOL_HOME" } });
  fireEvent.change(within(dialog).getByLabelText("Sign-in arguments"), { target: { value: "auth\nlogin" } });
}

function withCustomTool(): FakeClient {
  const fake = standardFake();
  fake.tools.get("p_work")?.push(toolView(toolSpec("mytool", "My Tool", { builtin: false }), null));
  return fake;
}

describe("custom tool dialog", () => {
  it("shows_an_error_under_each_invalid_field", async () => {
    const dialog = await openDialog(standardFake());
    fireEvent.click(within(dialog).getByRole("button", { name: "Add tool" }));
    expect(within(dialog).getByLabelText("Name")).toHaveAccessibleDescription(/Enter a name\./);
    expect(within(dialog).getByLabelText("Program")).toHaveAccessibleDescription(/Enter the program name/);
    expect(within(dialog).getByLabelText("Sign-in arguments")).toHaveAccessibleDescription(
      /Enter at least one argument/,
    );
  });

  it("does_not_call_the_core_when_the_form_is_invalid", async () => {
    const fake = standardFake();
    const dialog = await openDialog(fake);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add tool" }));
    expect(fake.calls("customToolSave")).toHaveLength(0);
  });

  it("derives_the_id_from_the_name", async () => {
    const dialog = await openDialog(standardFake());
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "My Tool" } });
    expect(within(dialog).getByLabelText("Id")).toHaveValue("my-tool");
  });

  it("rejects_an_id_that_already_exists", async () => {
    const dialog = await openDialog(standardFake());
    fillValid(dialog);
    fireEvent.change(within(dialog).getByLabelText("Id"), { target: { value: "gh" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add tool" }));
    expect(within(dialog).getByLabelText("Id")).toHaveAccessibleDescription(/already exists/);
  });

  it("shows_a_core_validation_error_under_its_field", async () => {
    const fake = standardFake().fail("customToolSave", "invalid_input", "The binary must be a plain name");
    const dialog = await openDialog(fake);
    fillValid(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add tool" }));
    await settled(within(dialog).findByText("The binary must be a plain name"));
    expect(within(dialog).getByLabelText("Program")).toHaveAccessibleDescription(
      /The binary must be a plain name/,
    );
  });

  it("adds_the_tool_and_checks_it", async () => {
    const fake = standardFake();
    const dialog = await openDialog(fake);
    fillValid(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add tool" }));
    expect(await settled(findCard("My Tool"))).toBeInTheDocument();
    expect(fake.calls("customToolSave")).toEqual([
      {
        tool: {
          id: "my-tool",
          name: "My Tool",
          binary: "mytool",
          config_var: "MYTOOL_HOME",
          config_kind: "dir",
          login: ["auth", "login"],
        },
      },
    ]);
    expect(fake.calls("toolCheck")).toContainEqual({ profile_id: "p_work", tool_id: "my-tool" });
  });

  it("closes_the_dialog_after_adding", async () => {
    const dialog = await openDialog(standardFake());
    fillValid(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add tool" }));
    await settled(findCard("My Tool"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("delete custom tool", () => {
  it("offers_delete_only_for_custom_tools", async () => {
    renderApp(withCustomTool());
    fireEvent.click(await settled(screen.findByRole("button", { name: "Tools" })));
    await settled(findCard("My Tool"));
    expect(within(card("My Tool")).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(within(card("GitHub CLI")).queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("removes_the_tool_after_confirmation", async () => {
    const fake = withCustomTool();
    renderApp(fake);
    fireEvent.click(await settled(screen.findByRole("button", { name: "Tools" })));
    fireEvent.click(within(await settled(findCard("My Tool"))).getByRole("button", { name: "Delete" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog", { name: "Delete My Tool?" })).getByRole("button", {
        name: "Delete tool",
      }),
    );
    await settled(screen.findByText("2 tools"));
    expect(screen.queryByRole("article", { name: "My Tool" })).toBeNull();
    expect(fake.calls("customToolDelete")).toEqual([{ tool_id: "mytool" }]);
  });

  it("keeps_the_dialog_open_with_the_error_when_delete_fails", async () => {
    const fake = withCustomTool().fail("customToolDelete", "io", "Disk full");
    renderApp(fake);
    fireEvent.click(await settled(screen.findByRole("button", { name: "Tools" })));
    fireEvent.click(within(await settled(findCard("My Tool"))).getByRole("button", { name: "Delete" }));
    const dialog = screen.getByRole("alertdialog", { name: "Delete My Tool?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete tool" }));
    expect(await settled(within(dialog).findByRole("alert"))).toHaveTextContent("Disk full");
    expect(card("My Tool")).toBeInTheDocument();
  });
});
