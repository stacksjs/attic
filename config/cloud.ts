import type { CloudConfig as TsCloudConfig } from '@stacksjs/ts-cloud'
import type { CloudConfig } from '@stacksjs/types'

export const tsCloud: TsCloudConfig = {
  project: { name: 'Texts', slug: 'attic', region: 'us-east-1' },
  stateDir: 'storage/cloud',
  cloud: { provider: 'hetzner', attachTo: 'stacks' },
  environments: {
    production: { type: 'production', deployBranch: 'main' },
  },
  sites: {
    website: {
      deploy: 'server',
      domain: 'texts.stacksjs.com',
      path: '/',
      root: 'storage/attic/site',
      build: 'bun run build:site',
      pathRewriteStyle: 'directory',
    },
    atticRedirect: {
      domain: 'attic.stacksjs.com',
      redirect: 'https://texts.stacksjs.com',
    },
    chatfoldRedirect: {
      domain: 'chatfold.stacksjs.com',
      redirect: 'https://texts.stacksjs.com',
    },
  },
}

export default {} satisfies CloudConfig
