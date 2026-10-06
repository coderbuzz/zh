import { describe, expect, test } from "bun:test";
import { formatSessionHash, parseSessionHash } from "../src/sessionUrl.js";

const SCOPE = "/home/ubuntu/workspace";

describe("session URL hash", () => {
  test("round-trips task, draft, and root-workspace targets", () => {
    for (const [workspacePath, taskId] of [
      [`${SCOPE}/nalar`, "sess_1"],
      [`${SCOPE}/nalar`, null],
      [SCOPE, "sess_2"],
      [`${SCOPE}/a/b`, "sess_3"],
    ] as const) {
      const hash = formatSessionHash(SCOPE, workspacePath, taskId);
      expect(parseSessionHash(hash ?? "", SCOPE)).toEqual({
        workspacePath,
        ...(taskId ? { taskId } : {}),
      });
    }
    expect(formatSessionHash(SCOPE, `${SCOPE}/nalar`, "sess_1")).toBe("#ws=nalar&task=sess_1");
    expect(formatSessionHash(SCOPE, `${SCOPE}/a/b`, null)).toBe("#ws=a/b");
  });

  test("root workspace draft clears the hash; outside the scope leaves it alone", () => {
    expect(formatSessionHash(SCOPE, SCOPE, null)).toBe("");
    expect(formatSessionHash(SCOPE, "/tmp/other", "sess_1")).toBeNull();
    expect(formatSessionHash(SCOPE, `${SCOPE}-other`, "sess_1")).toBeNull();
  });

  test("rejects empty hashes and paths escaping the scope", () => {
    expect(parseSessionHash("", SCOPE)).toBeNull();
    expect(parseSessionHash("#", SCOPE)).toBeNull();
    expect(parseSessionHash("#ws=../etc&task=x", SCOPE)).toBeNull();
    expect(parseSessionHash("#ws=a/./b", SCOPE)).toBeNull();
    expect(parseSessionHash("#ws=%2Fnalar%2F", SCOPE)).toEqual({ workspacePath: `${SCOPE}/nalar` });
  });
});
