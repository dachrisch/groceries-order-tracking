# Changelog

All notable changes to this project will be documented in this file. See [standard-version](https://github.com/conventional-changelog/standard-version) for commit guidelines.

## [1.2.0](https://github.com/dachrisch/groceries-order-tracking/compare/v1.1.0...v1.2.0) (2026-03-20)


### Features

* add product categories, current prices, and rebuy-time sorting ([e8ad02b](https://github.com/dachrisch/groceries-order-tracking/commit/e8ad02b52e51b5dddebffc7a35c2cbd7d5520dc0))
* show price +/- in cart drawer ([d0746da](https://github.com/dachrisch/groceries-order-tracking/commit/d0746dada2e54aa1069772a22f0d0ec4fee43cb0))


### Bug Fixes

* correctly extract amount from Knuspr price object ([603eaad](https://github.com/dachrisch/groceries-order-tracking/commit/603eaaddbf53c29c3596f130a9d62cd83b32c096))
* ensure currentPrice is always a number to avoid toFixed() errors ([54fd342](https://github.com/dachrisch/groceries-order-tracking/commit/54fd3426852a8c2ada639a6f8c73c08bff72ed03))
* resolve linting errors and Solid reactivity warnings ([fb4cd6e](https://github.com/dachrisch/groceries-order-tracking/commit/fb4cd6e82cabc20ee3757109dd52f227cf18f801))
* resolve remaining linting errors in tests and redundant operators in inventory page ([b49bb86](https://github.com/dachrisch/groceries-order-tracking/commit/b49bb86be4c7d086aa9349e5caaea97e4635afe5))

## 1.1.0 (2026-03-19)


### Features

* add AES-256-GCM encrypt/decrypt with PBKDF2 key derivation ([dfcbb12](https://github.com/dachrisch/groceries-order-tracking/commit/dfcbb123a0da9599437e9c18b218e4d54c6f8946))
* add cart state to inventory — mark added items and show cart summary ([0b52f28](https://github.com/dachrisch/groceries-order-tracking/commit/0b52f286837f781b6502f80505b01ae65b4173cf))
* add Integration model; remove legacy knusprCredentials from User ([932477d](https://github.com/dachrisch/groceries-order-tracking/commit/932477d83d5715a898f814b852a622089bfc7a69))
* add inventory aggregation API ([3e164e4](https://github.com/dachrisch/groceries-order-tracking/commit/3e164e4bb176150963bf2ccb1e06395c709cbe51))
* add Knuspr API login client ([fc85a0f](https://github.com/dachrisch/groceries-order-tracking/commit/fc85a0fc99a63f6210d7855de9580161c16755af))
* add Knuspr cart reorder proxy ([45f2f33](https://github.com/dachrisch/groceries-order-tracking/commit/45f2f3346211906d859241ffbf1c96795791e664))
* add pretzel emoji favicon ([fbcce8b](https://github.com/dachrisch/groceries-order-tracking/commit/fbcce8b74a3c17f06a0c5e30abae678c6fd91981))
* add settings controller and routes for Knuspr integration CRUD ([e90c02f](https://github.com/dachrisch/groceries-order-tracking/commit/e90c02f046df597ab22963cc601097f6a2ce467c))
* add Settings page with Knuspr integration management UI ([7145e37](https://github.com/dachrisch/groceries-order-tracking/commit/7145e3721186d03435bf841371489910bc791804))
* complete knuspr integration and fix ci build errors ([cd52727](https://github.com/dachrisch/groceries-order-tracking/commit/cd52727c0322e2feddc9001f65e1d06ccdc21163))
* derive and store AES key in httpOnly dkey cookie at login ([f306e56](https://github.com/dachrisch/groceries-order-tracking/commit/f306e562c6d4bc78ac33ce55c64b330ff62754dc))
* enhance Integration model with type safety, encryption, and provider enum ([86bed92](https://github.com/dachrisch/groceries-order-tracking/commit/86bed92805bcd04eae41747abf5f2322fdd84d5a))
* enhance inventory with categories, live pricing, and smart sorting ([#23](https://github.com/dachrisch/groceries-order-tracking/issues/23)) ([c6fd1fe](https://github.com/dachrisch/groceries-order-tracking/commit/c6fd1fefe0fd4fb19b0412b4e7e7b5b574d77103))
* fix cart add endpoint and add check-cart verification ([6ba98f5](https://github.com/dachrisch/groceries-order-tracking/commit/6ba98f5d34656e572aa43fdbb48bfd69ec126245))
* implement Inventory frontend with reorder functionality ([e7d8de0](https://github.com/dachrisch/groceries-order-tracking/commit/e7d8de08d2e36ee5113ca54bf15dec19b9311faa))
* implement Inventory frontend with reorder functionality ([316a6a7](https://github.com/dachrisch/groceries-order-tracking/commit/316a6a73a642afbf494581eb1c5670ddeebb302b))
* implement singular /order/[id] route and product query param tracking ([647afee](https://github.com/dachrisch/groceries-order-tracking/commit/647afeef9e9a826a5fdc979d35c2c169bce06416))
* improve product display with images and textual amounts, optimize build ([2742dd4](https://github.com/dachrisch/groceries-order-tracking/commit/2742dd4c22b5d305767c323f79a67f2a18a021ec))
* initial implementation of groceries tracking app with Knuspr import, dashboard, and product trends ([647cd4e](https://github.com/dachrisch/groceries-order-tracking/commit/647cd4e00c280775f2a16d88189f5cf818b8acd5))
* replace cURL-based import with API auth using encrypted stored credentials ([abc2d97](https://github.com/dachrisch/groceries-order-tracking/commit/abc2d9736f1a750ff30e7d404796868f902c3a8f))
* replace user avatar initial with pretzel icon ([7562f5e](https://github.com/dachrisch/groceries-order-tracking/commit/7562f5e5423478632a4556f5f1f7113b940b736d))
* update Integration model to store encrypted headers and cookies ([5dcc2ad](https://github.com/dachrisch/groceries-order-tracking/commit/5dcc2ad96dbf6345f5de0966ee7663b8b9dfc662))
* update Integration model to store full headers ([0b9d333](https://github.com/dachrisch/groceries-order-tracking/commit/0b9d3339b7296a13fbe43156e018544e55fdebb4))
* wire Settings route, sidebar nav, and update Import page to credential-free sync ([d8577b1](https://github.com/dachrisch/groceries-order-tracking/commit/d8577b10a9580242b26dabb91d733f6ef0085ca2))


### Bug Fixes

* --legacy-peer-deps to npm for eslint ([92520c6](https://github.com/dachrisch/groceries-order-tracking/commit/92520c60b7f0d4d2b7be59a2f4c73f193154721e))
* add --legacy-peer-deps to production npm install in Dockerfile ([7291a37](https://github.com/dachrisch/groceries-order-tracking/commit/7291a37119431e957956e3508ebafa3b69d070e9))
* add cookie options to clearCookie and simplify dkey cookie cast ([4484daa](https://github.com/dachrisch/groceries-order-tracking/commit/4484daae26eb4130eabb29f945430865fbfdf7ed))
* add error handling and input validation to settings controller ([905b38d](https://github.com/dachrisch/groceries-order-tracking/commit/905b38da1358b49ac698ec16625666938a5cd834))
* add role=alert and label/input associations for accessibility ([3ac942b](https://github.com/dachrisch/groceries-order-tracking/commit/3ac942bdc9cd5cd98ef6fe77437146d324b94149))
* **ci:** fix docker healthcheck and startup crash without MONGODB_URI ([#24](https://github.com/dachrisch/groceries-order-tracking/issues/24)) ([f890dda](https://github.com/dachrisch/groceries-order-tracking/commit/f890dda26dafc65ca83430937323d3c62c2395be))
* commit pre-existing local fixes (Integration model, knuspr-auth, mongodb, settings) ([e4f09c2](https://github.com/dachrisch/groceries-order-tracking/commit/e4f09c2371d16e3648c13cc9ce1bb6409c58e0d7))
* **deps:** remove unnecessary @types/mongoose and update lockfile ([d68f55a](https://github.com/dachrisch/groceries-order-tracking/commit/d68f55a9911aef51fec138978ef05a916504e7ed))
* **deps:** update dependency mongoose to v9 ([0fbc457](https://github.com/dachrisch/groceries-order-tracking/commit/0fbc457e9e774346341497b6cc4955a0412662c9))
* **deps:** update mongodb from v6 to v7 ([e211a83](https://github.com/dachrisch/groceries-order-tracking/commit/e211a83ed331f854b913654398856b257c1281ae))
* document early-stop ordering assumption; strip _id from Knuspr response before upsert ([890fd3d](https://github.com/dachrisch/groceries-order-tracking/commit/890fd3d7bb5969abc284683e5d7e1b30a37a82fb))
* document required name field in Knuspr login payload ([e8c8c5f](https://github.com/dachrisch/groceries-order-tracking/commit/e8c8c5fa10037183ae1c065449f1849b24728d8f))
* dynamic import mongodb-memory-server to avoid prod crash ([fbe0c85](https://github.com/dachrisch/groceries-order-tracking/commit/fbe0c85c50e841bb8e20af1a63c884f778a2bca0))
* **express:** path syntax https://expressjs.com/en/guide/migrating-5.html#path-syntax ([681ec24](https://github.com/dachrisch/groceries-order-tracking/commit/681ec24cd2ffa6d46c8bf37602be1188ed2317ab))
* handle fetch error/non-ok in Import page onMount to avoid blank page ([6b99140](https://github.com/dachrisch/groceries-order-tracking/commit/6b99140f2d56385a85ed46537d6e3aa9f60363c2))
* healthcheck.js ([b436ec3](https://github.com/dachrisch/groceries-order-tracking/commit/b436ec389365125fdaac12fd4a022a1303d63ed0))
* **mobile:** fix broken mobile layout with proper DaisyUI drawer pattern ([5f8e9ef](https://github.com/dachrisch/groceries-order-tracking/commit/5f8e9ef1dfe5960ec3eba274d9921dbf3c11990e))
* redirect to login when session is invalid or backend unreachable ([b7a766e](https://github.com/dachrisch/groceries-order-tracking/commit/b7a766ef8ab49028ee0cd991507a67c6333722e2))
* replace [@ts-ignore](https://github.com/ts-ignore) with [@ts-expect-error](https://github.com/ts-expect-error) to satisfy eslint ban-ts-comment ([1fdaf84](https://github.com/dachrisch/groceries-order-tracking/commit/1fdaf846eb12dce8a31bf06260152f7c8a8da606))
* resolve mongoMemoryServer scope in connectDB log ([b388ea2](https://github.com/dachrisch/groceries-order-tracking/commit/b388ea2d7edc98b148067788acbdad41e662d417))
* update formatZodError to use Zod v4 .issues API ([0d41e67](https://github.com/dachrisch/groceries-order-tracking/commit/0d41e6773f964f03e8ee470ab1cb5c58d5fa11ba))
* use --legacy-peer-deps in Docker build stage for eslint peer conflict ([fdc8572](https://github.com/dachrisch/groceries-order-tracking/commit/fdc857213177286b515a14369e187211fe251d50))
* use 12-byte GCM IV (NIST standard) and add decrypt format guard ([bd0e002](https://github.com/dachrisch/groceries-order-tracking/commit/bd0e0021b7d7fd8a8a3e680610eab645772b6e7a))
