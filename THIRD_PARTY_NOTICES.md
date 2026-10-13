# Third-Party Notices

Original GUILIU code is licensed under the MIT License in `LICENSE`.
Third-party software, icons, trademarks, and data retain their own terms;
the GUILIU license does not relicense them.

| Component | License | Notice location |
| --- | --- | --- |
| DDGS, pinned source | MIT | `agent/vendor/ddgs/LICENSE.md` |
| TanStack Virtual | MIT | `frontend/src/vendor/tanstack-virtual-core/LICENSE` |
| Lucide category icons | ISC, including upstream Feather attribution | `frontend/assets/category-icons/LICENSE` |
| OpenAI icon from LobeHub Icons | MIT | `frontend/assets/openai-LICENSE.txt` |
| Qwen icon | Apache-2.0 | `frontend/assets/qwen-LICENSE.txt` |
| Workspace photo `frontend/assets/finance-source.jpg` by Michal Jarmoluk, via Pixnio | CC0 1.0 (public domain) | Photographer credit kept in the file's metadata |

Gmail and Google are trademarks of Google LLC. NetEase, 163 Mail, OpenAI,
Qwen and DashScope are trademarks of their respective owners. These names and
the two service icons are used only to identify the services GUILIU connects to. GUILIU is not affiliated with or endorsed by any
of these companies, and the Apache-2.0 and MIT icon licenses above grant no
trademark rights.

At run time GUILIU fetches data from third-party services under their own
terms: current exchange rates from ExchangeRate-API's open access endpoint
(attribution "Rates By Exchange Rate API" is shown on the assets page), daily
history rates from Frankfurter (European Central Bank reference rates), and web
search results through DDGS. These data are for the user's own use; check each
service's terms before redistributing them.

The Windows offline edition includes original Python wheels under
`wheelhouse/`. Each wheel retains its upstream metadata and license files.
`DEPENDENCIES.json` records package versions, hashes and declared licenses;
`licenses/python/` contains extracted upstream license and notice files.
These files describe upstream declarations, not a replacement license or a
claim that every dependency is MIT. Consult each component's actual terms.

`dependency-sources/` also contains unmodified source distributions for
certifi, tqdm, primp and both Lance Namespace packages. Their exact versions,
upstream download URLs, hashes and supplementary notices are recorded in
`dependency-sources/SOURCES.json`. License files absent from a Lance Namespace
wheel are supplied from its corresponding upstream v0.13.0 source commit.

The Windows portable edition also redistributes official CPython and Node.js
binaries. Exact versions, upstream archive URLs, checksums and adaptations
are recorded in `RUNTIMES.json`. CPython's PSF license and bundled-component
notices are in `runtime/python/LICENSE.txt`. Node.js's MIT license and its
third-party notices are in `runtime/node/LICENSE`. They retain their original
terms. Python dependencies are preinstalled under `runtime/python/Lib/site-packages`.
The source/offline-dependency edition does not include these runtimes.
Google, DashScope and OpenAI API access requires the user's own credentials
and is subject to the respective service terms and charges.
