import type { Theme } from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi, makeTheme } from "@juicesharp/rpiv-test-utils";
import { afterEach, describe, expect, it } from "vitest";
import { isTaskDetails, replayFromBranch } from "./state/replay.ts";
import { __resetState, registerTodoTool, setActiveRenderSession } from "./todo.ts";
import { formatOverlayTaskLine } from "./view/format.ts";

const theme = makeTheme() as unknown as Theme;

afterEach(() => __resetState());

describe("todo upstream repair — renderer and replay compatibility", () => {
	it("renders an illegal transition as failure without changing its result envelope", async () => {
		__resetState();
		setActiveRenderSession("test-session");
		const { pi, captured } = createMockPi();
		registerTodoTool(pi);
		const tool = captured.tools.get("todo")!;
		const ctx = createMockCtx();
		const execute = (params: Record<string, unknown>) =>
			tool.execute!("tc", params as never, undefined as never, undefined as never, ctx as never);
		await execute({ action: "create", subject: "kept" });
		await execute({ action: "update", id: 1, status: "in_progress" });
		await execute({ action: "update", id: 1, status: "completed" });
		const result = await execute({ action: "update", id: 1, status: "pending" });
		expect(result.content).toEqual([{ type: "text", text: "Error: illegal transition completed → pending" }]);
		expect(result).not.toHaveProperty("isError");
		expect(result.details).toMatchObject({
			action: "update",
			params: { id: 1, status: "pending" },
			tasks: [{ id: 1, subject: "kept", status: "completed" }],
			nextId: 2,
			error: "illegal transition completed → pending",
		});
		const beforeRender = JSON.stringify(result);
		const node = tool.renderResult!(result as never, {} as never, theme, { isError: false } as never);
		const text = (node as unknown as { text: string }).text;
		expect(text).toContain("✗ illegal transition completed → pending");
		expect(text).not.toContain("✓");
		expect(JSON.stringify(result)).toBe(beforeRender);
		expect(captured.entries).toHaveLength(3);
	});

	it.each([NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects an unsafe nextId %s", (nextId) => {
		expect(isTaskDetails({ tasks: [], nextId })).toBe(false);
	});

	it.each(["custom", "toolResult"])("renders the last valid overlay task after corrupt %s replay", (source) => {
		const valid = { tasks: [{ id: 1, subject: "retained", status: "pending" }], nextId: 2 };
		const corrupt = { tasks: [...valid.tasks, "[output-policy: array truncated]"], nextId: 9 };
		const entry = (data: unknown) =>
			source === "custom"
				? { type: "custom", customType: "rpiv-todo-state", data }
				: { type: "message", message: { role: "toolResult", toolName: "todo", details: data } };
		const state = replayFromBranch({ sessionManager: { getBranch: () => [entry(valid), entry(corrupt)] } });
		expect(state).toEqual(valid);
		expect(state.tasks.map((task) => formatOverlayTaskLine(task, theme, true)).join("\n")).toContain("retained");
	});
});
