import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { createMockCtx, createMockPi, createMockUI, makeTheme } from "@juicesharp/rpiv-test-utils";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { isTaskDetails, replayFromBranch } from "./state/replay.ts";
import { replaceState } from "./state/store.ts";
import { __resetState, registerTodoTool, setActiveRenderSession } from "./todo.ts";
import { TodoOverlay } from "./todo-overlay.ts";
import { formatOverlayTaskLine } from "./view/format.ts";

// Vitest hoists this before runtime imports, including config consumers in test utilities.
const { testHome, configPath } = await vi.hoisted(async () => {
	const { mkdtempSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const testHome = mkdtempSync(join(tmpdir(), "todo-upstream-repair-"));
	vi.stubEnv("HOME", testHome);
	vi.stubEnv("USERPROFILE", testHome);
	vi.stubEnv("XDG_CONFIG_HOME", join(testHome, ".config"));
	vi.stubEnv("PI_CODING_AGENT_DIR", join(testHome, ".pi", "agent"));
	return { testHome, configPath: join(testHome, ".config", "rpiv-todo", "config.json") };
});

const theme = makeTheme() as unknown as Theme;

afterAll(() => {
	try {
		rmSync(testHome, { recursive: true, force: true });
	} finally {
		vi.unstubAllEnvs();
	}
});

afterEach(() => {
	__resetState();
	rmSync(configPath, { force: true });
});

describe("todo upstream repair — renderer and replay compatibility", () => {
	it("keeps collapsedLines and heading clicks after corrupt replay and a rejected mutation", async () => {
		__resetState();
		setActiveRenderSession("test-session");
		mkdirSync(dirname(configPath), { recursive: true });
		writeFileSync(configPath, JSON.stringify({ collapsedLines: 1 }));
		const valid = { tasks: [{ id: 1, subject: "retained", status: "pending" }], nextId: 2 };
		const state = replayFromBranch({
			sessionManager: {
				getBranch: () =>
					[valid, { tasks: ["[output-policy: array truncated]"], nextId: 9 }].map((data) => ({
						type: "custom",
						customType: "rpiv-todo-state",
						data,
					})),
			},
		});
		replaceState("test-session", state);
		const { pi, captured } = createMockPi();
		registerTodoTool(pi);
		const tool = captured.tools.get("todo")!;
		const result = await tool.execute!(
			"tc",
			{ action: "update", id: 99, status: "completed" } as never,
			undefined as never,
			undefined as never,
			createMockCtx() as never,
		);
		const error = tool.renderResult!(result as never, {} as never, theme, { isError: false } as never);
		expect((error as unknown as { text: string }).text).toContain("✗");
		const ui = createMockUI() as unknown as ExtensionUIContext;
		const overlay = new TodoOverlay();
		overlay.setUICtx(ui);
		overlay.update();
		const factory = (ui.setWidget as ReturnType<typeof vi.fn>).mock.calls[0][1];
		const widget = factory({ requestRender: vi.fn() }, theme);
		expect(widget.render(200).join("\n")).toContain("retained");
		const click: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 3,
			y: 0,
			screenX: 13,
			screenY: 40,
			width: 120,
			height: 1,
			shift: false,
			alt: false,
			ctrl: false,
		};
		expect(widget.handleMouse(click)?.handled).toBe(true);
		expect(widget.render(200)).toHaveLength(1);
		expect(widget.render(200)[0]).toContain("to expand");
		expect(widget.handleMouse(click)?.handled).toBe(true);
		expect(widget.render(200).join("\n")).toContain("retained");
		overlay.dispose();
	});
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
