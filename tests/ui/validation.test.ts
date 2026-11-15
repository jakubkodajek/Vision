import { describe, expect, it } from "vitest";
import { rowErrors, type EntryRow } from "../../src/lib/mcp";
import { linesToList } from "../../src/lib/text";
import {
  customToolErrors,
  customToolField,
  mcpField,
  serverUrlError,
  toolIdFromName,
} from "../../src/lib/validation";

describe("serverUrlError mirrors the core (CR-14)", () => {
  it.each([
    ["https://mcp.example.com/mcp", null],
    ["https://mcp.example.com:8443", null],
    ["http://localhost:3000/mcp", null],
    ["http://127.0.0.1", null],
    ["http://[::1]:8080/", null],
    ["http://LOCALHOST:3000", null],
    ["HTTPS://mcp.example.com", "The URL must start with https://."],
    ["Http://localhost", "The URL must start with https://."],
    ["https://user:pw@mcp.example.com", "Put credentials in a header, not in the URL."],
    ["https://token@mcp.example.com/x", "Put credentials in a header, not in the URL."],
    [
      "http://mcp.example.com",
      "Plain http:// is only allowed for localhost, 127.0.0.1 and [::1]; use https://.",
    ],
    ["https:///path", "The URL has no host."],
    ["mcp.example.com", "The URL must start with https://."],
    ["ftp://mcp.example.com", "The URL must start with https://."],
    ["https://mcp.example.com/a b", "The URL is too long or contains spaces."],
    [`https://e.com/${"a".repeat(2040)}`, "The URL is too long or contains spaces."],
  ])("checks_%s", (url, expected) => {
    expect(serverUrlError(url)).toBe(expected);
  });
});

describe("linesToList (CR-13)", () => {
  it("keeps_spaces_inside_a_line", () => {
    expect(linesToList("  a b  \n c")).toEqual(["  a b  ", " c"]);
  });

  it("removes_only_a_trailing_carriage_return", () => {
    expect(linesToList("a\r\nb\r")).toEqual(["a", "b"]);
  });

  it("drops_only_completely_empty_lines", () => {
    expect(linesToList("a\n\n \nb\n")).toEqual(["a", " ", "b"]);
  });
});

describe("toolIdFromName (UX-34)", () => {
  it("cuts_a_long_slug_at_the_last_hyphen_before_32", () => {
    expect(toolIdFromName("Super Long Internal Deployment Helper Tool")).toBe(
      "super-long-internal-deployment",
    );
  });

  it("cuts_a_single_long_word_at_32", () => {
    expect(toolIdFromName("a".repeat(40))).toBe("a".repeat(32));
  });
});

describe("config variable (A6)", () => {
  const draft = {
    name: "T",
    id: "t",
    description: "",
    binary: "t",
    configKind: "dir" as const,
    login: ["login"],
    status: [],
    logout: [],
    installUrl: "",
  };

  it("accepts_kubeconfig", () => {
    expect(customToolErrors({ ...draft, configVar: "KUBECONFIG" }).configVar).toBeUndefined();
  });

  it("rejects_a_variable_without_a_config_suffix", () => {
    expect(customToolErrors({ ...draft, configVar: "BROWSER" }).configVar).toMatch(/End the name with/);
  });
});

describe("core error fields (A1)", () => {
  it("maps_a_custom_tool_field", () => {
    expect(customToolField({ field: "config_var" })).toBe("configVar");
  });

  it("maps_headers_and_env_to_the_entries", () => {
    expect([mcpField({ field: "env" }), mcpField({ field: "headers" })]).toEqual(["entries", "entries"]);
  });

  it("returns_null_without_a_field", () => {
    expect(customToolField({ field: null })).toBeNull();
  });
});

describe("rowErrors (UX-13)", () => {
  const row = (uid: string, key: string, value: string, extra: Partial<EntryRow> = {}): EntryRow => ({
    uid,
    key,
    value,
    secret: false,
    stored: false,
    wasStored: false,
    ...extra,
  });

  it("reports_header_duplicates_case_insensitively", () => {
    expect(rowErrors([row("a", "X-Team", "1"), row("b", "x-team", "2")], "header", false)).toEqual([
      {
        uid: "b",
        part: "key",
        message: "'x-team' is listed twice. Remove one of them.",
      },
    ]);
  });

  it("reports_every_problem", () => {
    expect(rowErrors([row("a", "", "1"), row("b", "K", "", { secret: true })], "env", false)).toHaveLength(2);
  });

  it("asks_for_a_stored_secret_again_after_a_destination_change", () => {
    expect(
      rowErrors([row("a", "K", "", { secret: true, stored: true, wasStored: true })], "env", true),
    ).toEqual([
      {
        uid: "a",
        part: "value",
        message: "Enter this value again because the server address or command changed.",
      },
    ]);
  });
});
