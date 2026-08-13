import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { AspireResourceExtendedDebugConfiguration, ExecutableLaunchConfiguration, isBrowserLaunchConfiguration, LaunchOptions } from "../../dcp/types";
import { browserDisplayName, browserLabel, invalidLaunchConfiguration, unsupportedBrowserDebugTarget, unsupportedBrowserDebugTargetWithoutUrl } from "../../loc/strings";
import { extensionLogOutputChannel } from "../../utils/logging";
import { ResourceDebuggerExtension } from "../debuggerExtensions";

// Map debug session IDs to their temporary browser profiles for cleanup on termination.
const sessionProfileDirs = new Map<string, string>();

function getBlazorWasmBrowser(browser: string | undefined): string {
    if (!browser || browser === 'msedge' || browser === 'pwa-msedge') {
        return 'edge';
    }

    if (browser === 'pwa-chrome') {
        return 'chrome';
    }

    return browser;
}

/**
 * Browsers VS Code's built-in js-debug can debug, mapped to the debug type it registers.
 *
 * `WithBrowserDebugger(browser)` on the hosting side accepts an arbitrary string, so an unmapped
 * value would otherwise be forwarded as `pwa-<value>` and fail inside VS Code with an opaque
 * "Configured debug type is not supported" once the session is already starting. js-debug only
 * contributes `pwa-chrome` and `pwa-msedge` for browsers:
 * https://github.com/microsoft/vscode-js-debug/blob/main/package.json
 *
 * A `Map` rather than an object literal because the lookup key is attacker-influenced data from the
 * AppHost: an object literal inherits `Object.prototype`, so `toString`, `constructor`, `__proto__`
 * and friends would resolve to inherited members and slip past the allowlist as a non-string debug
 * type. `Map` has no such inherited keys.
 */
const browserDebugTypesByName: ReadonlyMap<string, string> = new Map([
    ['msedge', 'pwa-msedge'],
    ['chrome', 'pwa-chrome'],
]);

export const browserDebuggerExtension: ResourceDebuggerExtension = {
    resourceType: 'browser',
    debugAdapter: 'pwa-msedge',
    extensionId: null, // built-in to VS Code via js-debug
    getDisplayName: (launchConfiguration: ExecutableLaunchConfiguration) => {
        if (isBrowserLaunchConfiguration(launchConfiguration) && launchConfiguration.url) {
            return browserDisplayName(launchConfiguration.url);
        }
        return browserLabel;
    },
    getSupportedFileTypes: () => [],
    getProjectFile: () => '',
    createDebugSessionConfigurationCallback: async (launchConfig, _args, _env, launchOptions, debugConfiguration: AspireResourceExtendedDebugConfiguration): Promise<void> => {
        if (!isBrowserLaunchConfiguration(launchConfig)) {
            extensionLogOutputChannel.info(`The resource type was not browser for ${JSON.stringify(launchConfig)}`);
            throw new Error(invalidLaunchConfiguration(JSON.stringify(launchConfig)));
        }

        const projectPath = launchConfig.web_root;
        const url = launchConfig.url;

        // Map browser name to VS Code js-debug adapter type (pwa- prefix required)
        // `??` rather than `||`: only an absent browser (an older AppHost that does not send the
        // field) should fall back to the default. An explicit empty string is a value the caller
        // chose, and it is no more supported than 'safari' would be, so it has to reach the
        // allowlist check and be rejected instead of silently launching Edge.
        const browser = launchConfig.browser ?? 'msedge';
        const debugType = browserDebugTypesByName.get(browser);
        if (!debugType) {
            extensionLogOutputChannel.warn(`No built-in js-debug adapter is registered for browser '${browser}'.`);
            // The toast this becomes only carries the message, and the URL is the one field of a
            // browser launch configuration a user recognises. There is deliberately no run-ID
            // fallback: the DCP `run_session` handler that turns this into an HTTP 500 already
            // prefixes the message with "Failed to start debug session for run ID <runId>", so
            // repeating the run ID here would print it twice and add nothing.
            const url = launchConfig.url?.trim();
            const supportedBrowsers = [...browserDebugTypesByName.keys()].join(', ');
            throw new Error(url
                ? unsupportedBrowserDebugTarget(browser, url, supportedBrowsers)
                : unsupportedBrowserDebugTargetWithoutUrl(browser, supportedBrowsers));
        }

        debugConfiguration.type = debugType;
        debugConfiguration.request = 'launch';
        debugConfiguration.url = launchConfig.url;
        // The hosting side defaults web_root to an empty string when the resource has no web root,
        // and a whitespace-only value is as broken as an empty one - it just happens to be truthy.
        //
        // There is no value that makes js-debug ignore webRoot: it defaults the property to
        // '${workspaceFolder}' whenever the launch configuration omits it, so "no web root" is not
        // expressible.
        // https://github.com/microsoft/vscode-js-debug/blob/main/src/configuration.ts
        //
        // Omitting it therefore does not disable source-map resolution; it opts into that
        // documented '${workspaceFolder}' default, which is the intended behaviour here. The
        // alternative - forwarding the blank string - is strictly worse: js-debug takes webRoot as
        // a real path, and resolving source maps against '' produces paths rooted at the filesystem
        // root rather than at the workspace.
        //
        // Trim only to decide whether the value is blank; forward the original. Leading and
        // trailing spaces are valid characters in a POSIX path, so trimming the forwarded value
        // would silently redirect a web root such as '/workspace/frontend ' to a different
        // directory. This matches how `browser` above is handled: validate what was sent, relay it
        // unchanged.
        if (launchConfig.web_root?.trim()) {
            debugConfiguration.webRoot = launchConfig.web_root;
        }
        else {
            // The base configuration is copied before this callback runs, so omission alone can
            // retain an unrelated inherited webRoot. A blank AppHost value explicitly requests
            // js-debug's normal workspace default.
            delete debugConfiguration.webRoot;
        }

        debugConfiguration.sourceMaps = true;
        debugConfiguration.resolveSourceMapLocations = ['**', '!**/node_modules/**'];
        // Create a unique temporary profile directory for this debug session to avoid
        // concurrent sessions racing on the same browser profile and to ensure profile
        // data is cleaned up when the session ends.
        const sessionProfileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aspire-browser-debug-'));
        debugConfiguration.userDataDir = sessionProfileDir;
        
        // Store the profile directory so we can clean it up when the debug session terminates.
        const debugSessionId = debugConfiguration.debugSessionId;
        if (debugSessionId) {
            sessionProfileDirs.set(debugSessionId, sessionProfileDir);
        }

        // Suppress Edge/Chrome first-run wizards and profile selection prompts
        // that appear on managed machines with enterprise policies.
        debugConfiguration.runtimeArgs = [
            '--no-first-run',
            '--no-default-browser-check',
            '--hide-crash-restore-bubble',
            '--disable-features=EdgeProfileOnStartup,msEdgeFirstRunExperience,EdgeBackgroundMode',
            '--disable-background-mode',
        ];

        // Remove program/args/cwd since browser debugging doesn't use them
        delete debugConfiguration.program;
        delete debugConfiguration.args;
        delete debugConfiguration.cwd;

        if (typeof projectPath === 'string' && projectPath.endsWith('.csproj') && url) {
            extensionLogOutputChannel.info(`[WASM] Detected Blazor WASM project: ${projectPath}`);
            debugConfiguration.type = 'blazorwasm';
            debugConfiguration.request = 'attach';
            debugConfiguration.projectPath = projectPath;
            debugConfiguration.cwd = path.dirname(projectPath);
            debugConfiguration.url = url;
            debugConfiguration.browser = getBlazorWasmBrowser(launchConfig.browser);
            debugConfiguration.noDebug = !launchOptions.debug;

            delete debugConfiguration.program;
            delete debugConfiguration.args;

            extensionLogOutputChannel.info(`[WASM] Final debug config: name=${debugConfiguration.name}, type=${debugConfiguration.type}, request=${debugConfiguration.request}, projectPath=${debugConfiguration.projectPath}, cwd=${debugConfiguration.cwd}, url=${debugConfiguration.url}, browser=${debugConfiguration.browser}, noDebug=${debugConfiguration.noDebug}`);
            registerBrowserSessionTerminationNotification(debugConfiguration, launchOptions);
            return;
        }

        extensionLogOutputChannel.info(`[Browser] Final debug config: type=${debugConfiguration.type}, url=${debugConfiguration.url}, webRoot=${debugConfiguration.webRoot}, noDebug=${debugConfiguration.noDebug}`);

        registerBrowserSessionTerminationNotification(debugConfiguration, launchOptions);
    }
};

function registerBrowserSessionTerminationNotification(debugConfiguration: AspireResourceExtendedDebugConfiguration, launchOptions: LaunchOptions): void {
    // Listen for the browser debug session to terminate (e.g., user closes the browser window).
    // When it does, notify DCP so the resource transitions to a terminal state and
    // the dashboard UI can reset.
    // We match by session name only because js-debug child sessions do not carry
    // custom configuration properties (runId) from the parent launch config.
    const runId = debugConfiguration.runId;
    const debugSessionId = debugConfiguration.debugSessionId;
    const aspireSession = launchOptions.debugSession;
    const browserSessionName = debugConfiguration.name;

    if (runId && debugSessionId) {
        extensionLogOutputChannel.info(`[Browser] Registering terminate listener for session name="${browserSessionName}", runId=${runId}, debugSessionId=${debugSessionId}`);
        const disposable = vscode.debug.onDidTerminateDebugSession((session) => {
            extensionLogOutputChannel.info(`[Browser] onDidTerminateDebugSession fired: name="${session.name}", configRunId=${session.configuration?.runId}, expected="${browserSessionName}"`);
            if (session.name === browserSessionName) {
                disposable.dispose();
                extensionLogOutputChannel.info(`[Browser] Browser debug session terminated — notifying DCP (runId: ${runId}, debugSessionId: ${debugSessionId})`);
                aspireSession.sendSessionTerminated(runId, debugSessionId, 0);
                
                // Clean up the temporary profile directory for this session.
                if (debugSessionId && sessionProfileDirs.has(debugSessionId)) {
                    const profileDir = sessionProfileDirs.get(debugSessionId)!;
                    sessionProfileDirs.delete(debugSessionId);
                    try {
                        fs.rmSync(profileDir, { recursive: true, force: true });
                        extensionLogOutputChannel.info(`[Browser] Cleaned up browser profile directory: ${profileDir}`);
                    } catch (error) {
                        extensionLogOutputChannel.error(`[Browser] Failed to clean up browser profile directory ${profileDir}: ${error}`);
                    }
                }
            }
        });
    }
}
