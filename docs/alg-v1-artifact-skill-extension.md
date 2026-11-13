# ALG Optional Artifact Skill Extension

Draft revised 9 November 2026. Optional later work for the OpenCode 1 host; outside Phase One. The [design index](alg-v1-design-index.md) owns delivery order. This preserves the user-requested artifact skill without making it the initial applicability or evaluation workload.

Add Anthropic's web-artifacts-builder as an optional, versioned reference skill pack for V1. Use it to exercise the same applicability, approval, complete-procedure restoration, helper tracking and measured-promotion mechanisms as any other imported skill. It is not enabled globally, installed by this design update, or granted special trust because of its publisher.

The upstream skill targets complex interactive HTML artifacts and packages a frontend project into a single HTML deliverable. Its stated workflow covers project initialization, implementation, bundling and presentation; testing is optional upstream. ALG adds an explicit verification policy for measured acceptance. The public skill is a reusable procedure, not the implementation of Claude's proprietary artifact viewer. [Upstream skill](https://github.com/anthropics/skills/blob/main/skills/web-artifacts-builder/SKILL.md)

### Source identity and companion procedure

Import a reviewed repository commit, preserve its upstream files and supplied license notices, and record file digests plus all local changes. Keep the upstream identity distinct from the ALG adaptation. A moving main URL is a discovery source, never an approved execution reference. Capture the component archive and resolved build dependencies as well as SKILL.md and the two shell scripts.

frontend-design is a separately approved companion for visual design work. Select it when the task includes interface design or redesign; do not require it for a mechanical rebuild or bundle repair. Its scope, source revision, instruction budget and evaluation remain distinct. User-provided visual requirements take precedence over generic style preferences. [Companion skill](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md)

The supplied skill licenses identify Apache 2.0. Packaging must retain the applicable license and notices and identify modified files; separately inventory bundled components and third-party package licenses. Importing a public skill neither approves every script effect nor delegates its publisher's identity to an ALG fork. [Builder license](https://github.com/anthropics/skills/blob/main/skills/web-artifacts-builder/LICENSE.txt), [companion license](https://github.com/anthropics/skills/blob/main/skills/frontend-design/LICENSE.txt)

### Applicability and portability

Proposed operation IDs artifact.web.create and artifact.web.bundle belong to the reviewed operation registry; they are not currently supported configuration. Match on the requested deliverable and established host capabilities.

| Condition | Selection or action |
| --- | --- |
| Multi-component interactive HTML, stateful controls, or client-side navigation | Candidate for the builder; resolve runtime and helper prerequisites |
| One small static HTML page or explanation | Prefer a simpler procedure; do not force a framework project |
| Visual design or redesign | Consider the approved frontend-design companion |
| Bundling an existing compatible project | Use only the applicable bundling procedure and declared assets |
| Missing runtime, uncertain shell, or incomplete offline cache | Report unknown or incompatible as appropriate; do not attempt installation implicitly |
| Backend hosting, production deployment, or proprietary Claude viewer integration | Outside this pack's scope; resolve another authorized workflow |

The source scripts use Bash and Unix utilities. Initialization can install pnpm globally and resolve dependencies from the network; bundling adds development dependencies and removes previous dist and bundle.html output in its working directory. These are declared helper effects, not merely text instructions. [Initializer](https://github.com/anthropics/skills/blob/main/skills/web-artifacts-builder/scripts/init-artifact.sh), [bundler](https://github.com/anthropics/skills/blob/main/skills/web-artifacts-builder/scripts/bundle-artifact.sh)

The ALG adaptation must use an explicit scratch/project root, validate all write and cleanup targets within it, and avoid changing user-global tools or repositories as a side effect. On Windows, select a tested configured Bash environment or a separately versioned Node/PowerShell adapter; never submit Bash syntax to a cmd.exe shell gate. A missing shell is an environment preflight result, not a reason to repeat implementation.

Separate dependency preparation from artifact execution. Resolve and lock the exact runtime, scaffolder, package manager and packages in an approved preparation step. Execution uses that prepared inventory and frozen lockfile. In an air-gapped profile, require a complete verified local dependency store and prohibit network fallback. A Node major-version check or the skill's stated stack is not sufficient evidence that a floating scaffolder or dependency set works.

### Instructions and executable assets

Preserve complete selected instructions in the existing context path. Track scripts, bundled component archives, dependency manifests and lockfiles as immutable helper assets referenced by the skill revision and evaluation receipt. Do not inject binary archives, node_modules or the full build toolchain into model context.

Use the existing capability asset inventory and the knowledge contract's helper-artifact boundary. This is an explicit extension for the optional pack, not a reinterpretation of binary files as existing text prerequisites or a silent increase of the eight-prerequisite limit. Pin and verify the archive itself and its extraction inventory, reject entries that escape the target root, and record the actual files used. A changed helper or dependency inventory requires a new compatible evaluation and approval.

Any compatibility adapter is a new candidate revision with upstream provenance. Keep policy adaptations explicit: testing before measured acceptance, local dependency preparation, approved filesystem scope and OpenCode delivery replace host-specific assumptions. Do not silently edit the upstream procedure while retaining its hash or evaluation status.

### Artifact workflow and evidence

For initial evaluation, use a fixed validated graph through the existing executor:

Brief and applicability -> design when required -> implementation -> bundling -> functional verification -> delivery.

Each step has a concrete output and verifier. Bind build metadata to the project revision, selected skill/helper closures, runtime and dependency inventory, bundle digest and validation receipts. Artifact file delivery, skill publication and a hosted-site deployment are different operations. A successful bundle does not authorize the latter two.

The OpenCode deliverable is a local HTML artifact and its source/evidence references. Use a supported local browser or preview adapter when available; do not claim native Claude Artifacts behavior in OpenCode. Any preview of generated code must use an explicitly permitted local profile without ambient credentials or unexpected network access. A loopback server, if needed, is a declared temporary resource with cleanup and verified ownership.

Measured acceptance requires the output to open and perform the declared interactions in the target delivery mode, with captured runtime errors and resource requests. Verify offline behavior rather than assuming that a single HTML file contains every font, image, dynamic chunk or external dependency. Test navigation and reload behavior where routing is part of the brief. Set bundle-size, rendering and accessibility criteria in the evaluation plan before comparing candidates.

For a design task, require captured layouts at declared viewport sizes, keyboard/focus checks and a separately recorded visual review against the brief. Design scores supplement behavioral gates; aesthetic preference cannot compensate for broken behavior. If browser inspection is unavailable, report a built-but-unverified artifact instead of a measured pass. Previews may be shown with that status.

This is an ALG policy difference from upstream's optional testing order. Bind the acceptance policy to the evaluation and publication decision; do not treat the upstream optional step as permission to skip a required verifier.

### Protected evaluation cases and graph improvement

Include a stateful analytical dashboard on synthetic data, a troubleshooting report with filtering, and a multi-view project/API explorer. Protect simple static work from unnecessary framework selection. Negative cases include absent Bash, paths with spaces on Windows, missing component archive, incomplete offline cache, changed lockfile/helper, external font/image requests, broken controls, navigation failures and a browser that cannot launch.

Compare a reviewed incumbent procedure with one adaptation under the same brief, data, model configuration, host and budget. Count preparation and build costs as well as model calls; identify cached and cold runs separately. Preserve existing successes when assessing portability changes or build optimizations. Simulated outputs exercise only the mechanism; actual artifact execution and interaction evidence are required for behavioral eligibility.

When this optional extension is selected, register its applicability and evaluation fixtures as profile-specific coverage. Release executable pack support only when its helper-asset and local-platform checks pass; the general skill feature does not wait on every frontend dependency. No upstream script is executed during design or metadata discovery.

The later graph-authoring stage may specialize this workflow through graph_json. Measured template improvement can compare a smaller graph against one with separate design or accessibility review, or a revised bundling strategy, without changing the brief or protected gates. Later run revision retains the same controlled-revision boundary as other tasks. No model names, provider APIs, new MCP or V2 code are required.
