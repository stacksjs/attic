import type { CloudConfig as TsCloudConfig } from '@stacksjs/ts-cloud'
import type { CloudConfig } from '@stacksjs/types'

export const tsCloud: TsCloudConfig = {
  project: { name: 'Chatfold', slug: 'attic', region: 'us-east-1' },
  stateDir: 'storage/cloud',
  cloud: { provider: 'hetzner', attachTo: 'stacks' },
  environments: {
    production: { type: 'production', deployBranch: 'main' },
  },
  sites: {
    website: {
      deploy: 'server',
      domain: 'chatfold.stacksjs.com',
      path: '/',
      root: 'storage/attic/site',
      build: 'bun run build:site',
      pathRewriteStyle: 'directory',
    },
    previousWebsite: {
      domain: 'attic.stacksjs.com',
      redirect: 'https://chatfold.stacksjs.com',
    },
  },
}

export default {} satisfies CloudConfig
