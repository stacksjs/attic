import { expect, test } from 'bun:test'
import { githubUpdateFetcher, manifestAsset, TEXTS_RELEASE_REPO, updateArchive, updateArchiveUrl } from '../../../app/Attic/updates'

const release = `https://github.com/${TEXTS_RELEASE_REPO}/releases`

test('the updater gets the public manifest and archive without credentials', async () => {
  const calls: Array<{ url: string, authorization: string | null }> = []
  const fetcher = githubUpdateFetcher(async (input, init) => {
    const url = String(input)
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') })
    return new Response('asset')
  })
  const archive = updateArchiveUrl('v0.3.5')
  expect(archive).toBe(`https://github.com/stacksjs/attic-downloads/releases/download/v0.3.5/Attic-0.3.5-${process.arch}.zip`)
  const options = { headers: { authorization: 'Bearer fixture-token' } }
  expect(await (await fetcher(`${release}/latest/darwin/${process.arch}?current=0.3.4`, options)).text()).toBe('asset')
  expect(await (await fetcher(archive, options)).text()).toBe('asset')
  expect(calls).toEqual([
    { url: `${release}/latest/download/${manifestAsset()}`, authorization: null },
    { url: `${release}/download/v0.3.5/${updateArchive('v0.3.5')}`, authorization: null },
  ])
})

test('the updater rejects archive URLs outside the signed release format', async () => {
  let fetched = false
  const fetcher = githubUpdateFetcher(async () => { fetched = true; return new Response() })
  const url = updateArchiveUrl('v0.3.5').replace('stacksjs/attic-downloads', 'someone/else')
  await expect(fetcher(url)).rejects.toThrow('does not point to a Texts release')
  expect(fetched).toBe(false)
})
