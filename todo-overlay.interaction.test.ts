import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Terminal, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import * as repoTui from "@earendil-works/pi-tui";
import { createMockCtx, createMockPi, createMockUI } from "@juicesharp/rpiv-test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as config from "./config.ts";
import { __resetState, registerTodoTool, setActiveRenderSession } from "./todo.ts";
import { TodoOverlay } from "./todo-overlay.ts";

// The same dispatch assertions can run against the installed target host.
const tuiSdk: typeof repoTui = process.env.RPIV_TODO_TEST_TUI_MODULE
	? await import(/* @vite-ignore */ process.env.RPIV_TODO_TEST_TUI_MODULE)
	: repoTui;

const identityTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
} as Theme;

async function setup() {
	__resetState();
	const { pi, captured } = createMockPi();
	registerTodoTool(pi);
	const ctx = createMockCtx();
	const tool = captured.tools.get("todo")!;
	for (let i = 1; i <= 16; i++) {
		await tool.execute!("tc", { action: "create", subject: `task ${i}` }, undefined, undefined, ctx as never);
	}
	for (let id = 1; id <= 6; id++) {
		await tool.execute!("tc", { action: "update", id, status: "completed" }, undefined, undefined, ctx as never);
	}
	setActiveRenderSession("test-session");
	let toolsExpanded = false;
	const ui = createMockUI({ getToolsExpanded: () => toolsExpanded }) as unknown as ExtensionUIContext;
	const overlay = new TodoOverlay();
	overlay.setUICtx(ui);
	overlay.update();
	function mount(tui: TUI = { requestRender: vi.fn() } as unknown as TUI): Component {
		const calls = (ui.setWidget as ReturnType<typeof vi.fn>).mock.calls;
		const factory = calls.at(-1)![1] as (tui: TUI, theme: Theme) => Component;
		return factory(tui, identityTheme);
	}
	const widget = mount();
	return { overlay, widget, mount, ui, expandTools: (value: boolean) => (toolsExpanded = value) };
}

const output = (widget: Component) => widget.render(80).join("\n");

afterEach(() => {
	__resetState();
	vi.restoreAllMocks();
});

describe("TodoOverlay — full expansion", () => {
	it("cycles normal with more → full → collapsed → normal with more", async () => {
		const { overlay, widget } = await setup();
		expect(output(widget)).toContain("+6 more (6 completed)");
		overlay.toggleCollapse();
		expect(widget.render(80)).toHaveLength(18);
		expect(output(widget)).not.toContain("more");
		overlay.toggleCollapse();
		expect(output(widget)).toContain("to expand");
		overlay.toggleCollapse();
		expect(output(widget)).toContain("+6 more");
	});

	it("reads current layout even before a render and after global expansion changes", async () => {
		const { overlay, widget, expandTools } = await setup();
		overlay.toggleCollapse();
		expect(widget.render(80)).toHaveLength(18);
		overlay.toggleCollapse();
		overlay.toggleCollapse();
		expandTools(true);
		expect(widget.render(80)).toHaveLength(18);
		overlay.toggleCollapse();
		expect(output(widget)).toContain("to expand");
		overlay.toggleCollapse();
		expandTools(false);
		expect(output(widget)).toContain("+6 more");
	});

	it("keeps local expansion through global toggles and replay reset, then hides completed tasks", async () => {
		const { overlay, widget, expandTools } = await setup();
		overlay.toggleCollapse();
		expandTools(true);
		expandTools(false);
		overlay.resetCompletedDisplayState();
		expect(widget.render(80)).toHaveLength(18);
		overlay.hideCompletedTasksFromPreviousTurn();
		expect(widget.render(80)).toHaveLength(12);
		expect(output(widget)).toContain("Todos (0/10)");
	});

	it("rejects old component callbacks after UI replacement and dispose, and resets on reuse", async () => {
		const { overlay, widget, ui } = await setup();
		output(widget);
		const themeRead = vi.fn(() => {
			throw new Error("old UI accessed");
		});
		Object.defineProperty(ui, "theme", { get: themeRead });
		const newUi = createMockUI() as unknown as ExtensionUIContext;
		overlay.setUICtx(newUi);
		overlay.update();
		expect(widget.render(80)).toEqual([]);
		expect(widget.handleMouse?.(mouse("click", 11))).toBeUndefined();
		expect(widget.handleMouse?.(mouse("click", 0))).toBeUndefined();
		expect(themeRead).not.toHaveBeenCalled();
		const factory = (newUi.setWidget as ReturnType<typeof vi.fn>).mock.calls[0][1];
		const nextWidget: Component = factory({ requestRender: vi.fn() }, identityTheme);
		overlay.toggleCollapse();
		expect(nextWidget.render(80)).toHaveLength(18);
		overlay.dispose();
		expect(nextWidget.render(80)).toEqual([]);
		expect(nextWidget.handleMouse?.(mouse("click", 0))).toBeUndefined();
		overlay.setUICtx(newUi);
		overlay.update();
		const fresh: Component = (newUi.setWidget as ReturnType<typeof vi.fn>).mock.calls.at(-1)![1](
			{ requestRender: vi.fn() },
			identityTheme,
		);
		expect(output(fresh)).toContain("+6 more");
	});
});

function mouse(type: TuiMouseEvent["type"], y: number, overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return {
		type,
		button: "left",
		x: 4,
		y,
		screenX: 4,
		screenY: y,
		width: 80,
		height: 13,
		shift: false,
		alt: false,
		ctrl: false,
		...overrides,
	};
}

describe("TodoOverlay — mouse dispatch", () => {
	it("claims only the rendered summary row and expands only on click", async () => {
		const { widget } = await setup();
		output(widget);
		for (const event of [
			mouse("click", 1),
			mouse("click", 12),
			mouse("click", 11, { x: -1 }),
			mouse("click", 11, { x: 79 }),
			mouse("click", 11, { button: "right" }),
			mouse("wheel", 11),
			mouse("drag", 11),
			mouse("click", 11, { width: 40 }),
			...["shift", "alt", "ctrl"].flatMap((modifier) =>
				["press", "release", "click"].map((type) => mouse(type as TuiMouseEvent["type"], 11, { [modifier]: true })),
			),
		]) {
			expect(widget.handleMouse?.(event)).toBeUndefined();
		}
		expect(widget.handleMouse?.(mouse("press", 11))).toEqual({ handled: true, render: false });
		expect(widget.handleMouse?.(mouse("release", 11))).toEqual({ handled: true, render: false });
		expect(output(widget)).toContain("+6 more");
		expect(widget.handleMouse?.(mouse("click", 11))).toEqual({ handled: true, render: false });
		expect(widget.render(80)).toHaveLength(18);
		expect(widget.handleMouse?.(mouse("click", 11))).toBeUndefined();
	});

	it("invalidates hit bounds on resize and collapse", async () => {
		const { widget, overlay } = await setup();
		output(widget);
		widget.invalidate();
		expect(widget.handleMouse?.(mouse("click", 11))).toBeUndefined();
		widget.render(10);
		expect(widget.handleMouse?.(mouse("click", 11))).toBeUndefined();
		expect(widget.handleMouse?.(mouse("click", 11, { x: 10, width: 10 }))).toBeUndefined();
		overlay.toggleCollapse();
		overlay.toggleCollapse();
		expect(widget.handleMouse?.(mouse("click", 11, { width: 10 }))).toBeUndefined();
	});

	it.each([1, 2])(
		"dispatches SGR press/release with collapsedLines=%i, preserves editor input, and rejects drags",
		async (collapsedLines) => {
			vi.spyOn(config, "getCollapsedLines").mockReturnValue(collapsedLines);
			const { mount } = await setup();
			let send = (_data: string) => {};
			let resize = () => {};
			let columns = 80;
			const terminal = new Proxy({} as Terminal, {
				get: (_target, key) => {
					if (key === "columns") return columns;
					if (key === "rows") return 40;
					if (key === "kittyProtocolActive") return false;
					if (key === "start")
						return (input: typeof send, onResize: typeof resize) => {
							send = input;
							resize = onResize;
						};
					if (key === "drainInput") return async () => {};
					return () => {};
				},
			});
			const screen = new tuiSdk.TuiAltScreen(terminal, false);
			const widget = mount(screen);
			const editorInput = vi.fn();
			const editor = { render: () => ["editor"], invalidate: () => {}, handleInput: editorInput };
			// Pi adds a leading spacer and mounts the factory component unchanged.
			const above = new tuiSdk.Container();
			above.addChild(new tuiSdk.Spacer(1));
			above.addChild(widget);
			screen.setLayoutRoot(
				new tuiSdk.VStack([
					{ component: above, basis: "auto" },
					{ component: editor, basis: "auto" },
				]),
			);
			screen.start();
			screen.setFocus(editor);
			try {
				screen.renderNow();
				// Local summary y=11, one leading spacer, SGR uses 1-based rows.
				send("\x1b[<0;5;13M");
				expect(output(widget)).toContain("+6 more");
				send("\x1b[<32;6;13M");
				send("\x1b[<0;6;13m");
				expect(output(widget)).toContain("+6 more");
				send("\x1b[<0;5;2M"); // heading
				send("\x1b[<0;5;2m");
				expect(output(widget)).toContain("to expand");
				expect(widget.render(80)).toHaveLength(collapsedLines === 1 ? 1 : 3);
				screen.renderNow();
				send("\x1b[<0;5;2M");
				send("\x1b[<0;5;2m");
				expect(output(widget)).toContain("+6 more");
				screen.renderNow();
				send("\x1b[<0;5;13M");
				columns = 60;
				resize();
				screen.renderNow();
				send("\x1b[<0;5;13m"); // the old target width must not activate a resized row
				expect(widget.render(60).join("\n")).toContain("+6 more");
				send("\x1b[<0;5;13M");
				send("\x1b[<0;5;13m");
				expect(widget.render(60)).toHaveLength(18);
				send("z");
				expect(editorInput.mock.calls).toEqual([["z"]]);
			} finally {
				screen.stop();
			}
		},
	);
});
