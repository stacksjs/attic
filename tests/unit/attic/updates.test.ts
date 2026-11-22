import { expect, test } from 'bun:test'
import { ATTIC_RELEASE_REPO, githubUpdateFetcher, manifestAsset, updateArchiveUrl } from '../../../app/Attic/updates'

const release = `https://github.com/${ATTIC_RELEASE_REPO}/releases`

test('the updater gets the public manifest and archive without credentials', async () => {
  const calls: Array<{ url: string, authorization: string | null }> = []
  const fetcher = githubUpdateFetcher(async (input, init) => {
    const url = String(input)
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') })
    return new Response('asset')
  })
  const archive = updateArchiveUrl('v0.3.5')
  const options = { headers: { authorization: 'Bearer fixture-token' } }
  expect(await (await fetcher(`${release}/latest/darwin/${process.arch}?current=0.3.4`, options)).text()).toBe('asset')
  expect(await (await fetcher(archive, options)).text()).toBe('asset')
  expect(calls).toEqual([
    { url: `${release}/latest/download/${manifestAsset()}`, authorization: null },
    { url: archive, authorization: null },
  ])
})

test('the updater only downloads archives from the public Attic repository', async () => {
  let fetched = false
  const fetcher = githubUpdateFetcher(async () => { fetched = true; return new Response() })
  const url = updateArchiveUrl('v0.3.5').replace(ATTIC_RELEASE_REPO, 'someone/else')
  await expect(fetcher(url)).rejects.toThrow('does not point to an Attic release')
  expect(fetched).toBe(false)
})
