import { defineConfig } from 'wxt';

// https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // Output to a visible folder (not the default hidden ".output") so it's easy
  // to pick in Finder when loading the unpacked extension.
  outDir: 'dist',
  manifest: {
    name: 'Guidely',
    description:
      'Record clicks into step-by-step guides and export them as a PDF. All data stays on your device. Built by Shaun Lee Wei Rong.',
    // host_permissions is required so capture survives page navigation: the
    // recorder is a declarative content script (re-injected on every page load)
    // and captureVisibleTab works via host access rather than the per-gesture
    // activeTab grant (which is released on navigation). This does surface the
    // "read your data on all websites" install notice — the trade-off for
    // reliable multi-page recording.
    permissions: ['scripting', 'storage', 'unlimitedStorage', 'sidePanel'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'Guidely — open recorder',
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
  },
});
