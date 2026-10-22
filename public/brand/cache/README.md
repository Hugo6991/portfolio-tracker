# Shared logo cache

96 pixel PNG copies of existing token and protocol logos from DeBank snapshot metadata, plus explicitly curated public brand icons

`lib/icon-catalog.json` maps original public logo URLs to content addressed files here. It contains no wallet addresses, balances, credentials or account metadata. Duplicate image contents share one file

`lib/icon-sources.json` lists curated symbols and provider brands. The Web3 Icons assets use upstream commit `3fa8ef5e17a1a213058a047e862499f00fc0dc81` under the MIT license in `../web3icons/LICENCE.txt`. DeBank and HTX brand icons come from the touch icons linked by their official homepages. Token and protocol marks remain the property of their respective owners and are used for identification, not endorsement

Refresh from an existing private full snapshot:

```sh
npm run icons:sync -- /absolute/path/to/private-snapshot.json
```

This command downloads only public images, never balances and never paid DeBank API data. It reuses existing files, validates origins and byte limits, rasterizes images to remove active content, and reports failed downloads with a nonzero exit. Successful entries are retained for retries. Never commit the input snapshot

All pages use the shared BrandMark component. Known brands use one canonical image. Other token rows keep their exact provider logo URL; Assets receives unambiguous logo metadata before the overview discards wallet details. Conflicting logos are not inferred from a shared ticker. New DeBank logo URLs work immediately via the provider CDN and become local when this command is run again. Missing images use a neutral symbol, not an invented logo
