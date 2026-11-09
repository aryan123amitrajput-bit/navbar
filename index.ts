import { registerRootComponent } from 'expo';
import { Platform } from 'react-native';

/**
 * Entry point.
 *
 * On web, CanvasKit (Skia compiled to WebAssembly) must be initialised *before* any module that
 * calls `Skia.*` at import time is evaluated — the glass shader compiles at module scope. So the app
 * is imported dynamically once CanvasKit is ready. Native platforms skip this entirely.
 */
if (Platform.OS === 'web') {
  void (async () => {
    try {
      const { LoadSkiaWeb } = await import('@shopify/react-native-skia/lib/module/web');
      await LoadSkiaWeb({ locateFile: (file: string) => `/${file}` });
      const App = (await import('./App')).default;
      registerRootComponent(App);
    } catch (error) {
      const root = typeof document !== 'undefined' ? document.getElementById('root') : null;
      if (root) {
        root.innerHTML =
          '<pre style="color:#f88;font:12px monospace;padding:16px;white-space:pre-wrap">' +
          String(error) +
          '</pre>';
      }
    }
  })();
} else {
  registerRootComponent(require('./App').default);
}
