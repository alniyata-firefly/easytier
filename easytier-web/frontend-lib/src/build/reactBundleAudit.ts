import type { Plugin } from 'vite'

/** Verify the actual output graph rather than inferring the framework from package.json. */
export function reactBundleAudit(): Plugin {
  return {
    name: 'adapted-react-bundle-audit',
    apply: 'build',
    generateBundle(_options, bundle) {
      const modules = new Set<string>()
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk') {
          for (const id of Object.keys(chunk.modules)) modules.add(id.replace(/\\/g, '/'))
        }
      }
      const legacy = [...modules].filter(id =>
        id.split('?')[0].endsWith('.vue')
        || /\/node_modules\/(?:vue(?:\/|$)|@vue\/|@vueuse\/|primevue(?:\/|$)|@primevue\/)/.test(id),
      )
      if (legacy.length) this.error('The React application includes legacy Vue or PrimeVue runtime modules')
      const react = [...modules].filter(id => /\/node_modules\/(?:react|react-dom)\//.test(id))
      if (!react.length) this.error('The application does not contain the expected React runtime')
      // Never publish absolute source paths or environment values in the audit artifact.
      this.emitFile({
        type: 'asset',
        fileName: 'react-bundle-audit.json',
        source: `${JSON.stringify({ schema_version: 1, framework: 'react', module_count: modules.size,
          react_module_count: react.length, legacy_vue_module_count: legacy.length }, null, 2)}\n`,
      })
    },
  }
}
