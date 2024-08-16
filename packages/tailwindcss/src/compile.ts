import { WalkAction, decl, rule, walk, type AstNode, type Rule } from './ast'
import { type Candidate, type Variant } from './candidate'
import { type DesignSystem } from './design-system'
import GLOBAL_PROPERTY_ORDER from './property-order'
import { asColor } from './utilities'
import { compare } from './utils/compare'
import { escape } from './utils/escape'
import type { Variants } from './variants'

export function compileCandidates(
  rawCandidates: Iterable<string>,
  designSystem: DesignSystem,
  { onInvalidCandidate }: { onInvalidCandidate?: (candidate: string) => void } = {},
) {
  let nodeSorting = new Map<
    AstNode,
    { properties: [number[], number[]]; variants: bigint; candidate: string }
  >()
  let astNodes: AstNode[] = []
  let candidates = new Map<Candidate, string>()

  // Parse candidates and variants
  for (let rawCandidate of rawCandidates) {
    let candidate = designSystem.parseCandidate(rawCandidate)
    if (candidate === null) {
      onInvalidCandidate?.(rawCandidate)
      continue // Bail, invalid candidate
    }
    candidates.set(candidate, rawCandidate)
  }

  // Sort the variants
  let variants = designSystem.getUsedVariants().sort((a, z) => {
    return designSystem.variants.compare(a, z)
  })

  // Create the AST
  next: for (let [candidate, rawCandidate] of candidates) {
    let astNode = designSystem.compileAstNodes(rawCandidate)
    if (astNode === null) {
      onInvalidCandidate?.(rawCandidate)
      continue next
    }

    let { node, propertySort } = astNode

    // Track the variant order which is a number with each bit representing a
    // variant. This allows us to sort the rules based on the order of
    // variants used.
    let variantOrder = 0n
    for (let variant of candidate.variants) {
      variantOrder |= 1n << BigInt(variants.indexOf(variant))
    }

    nodeSorting.set(node, {
      properties: propertySort,
      variants: variantOrder,
      candidate: rawCandidate,
    })
    astNodes.push(node)
  }

  astNodes.sort((a, z) => {
    // Safety: At this point it is safe to use TypeScript's non-null assertion
    // operator because if the ast nodes didn't exist, we introduced a bug
    // above, but there is no need to re-check just to be sure. If this relied
    // on pure user input, then we would need to check for its existence.
    let aSorting = nodeSorting.get(a)!
    let zSorting = nodeSorting.get(z)!

    let [aProperties, aCounts] = aSorting.properties
    let [zProperties, zCounts] = zSorting.properties

    // Sort by variant order first
    if (aSorting.variants - zSorting.variants !== 0n) {
      return Number(aSorting.variants - zSorting.variants)
    }

    // Find the first property that is different between the two rules
    let offset = 0
    while (
      aProperties.length < offset &&
      zProperties.length < offset &&
      aProperties[offset] === zProperties[offset]
    ) {
      offset += 1
    }

    // Sort by lowest property index first
    let lowestPropertyDelta = (aProperties[offset] ?? Infinity) - (zProperties[offset] ?? Infinity)
    if (lowestPropertyDelta) return lowestPropertyDelta

    // Sort by most properties first, then by least properties
    let uniquePropertyDelta = zProperties.length - aProperties.length
    if (uniquePropertyDelta) return uniquePropertyDelta

    // If both have the same unique properties, sort based on instances of those properties
    for (let i = 0; i < aProperties.length; i++) {
      let delta = zCounts[i] - aCounts[i]
      if (delta) return delta
    }

    // Sort alphabetically
    return compare(aSorting.candidate, zSorting.candidate)
  })

  return {
    astNodes,
    nodeSorting,
  }
}

export function compileAstNodes(rawCandidate: string, designSystem: DesignSystem) {
  let candidate = designSystem.parseCandidate(rawCandidate)
  if (candidate === null) return null

  let nodes = compileBaseUtility(candidate, designSystem)

  if (!nodes) return null

  let propertySort = getPropertySort(nodes)

  if (candidate.important) {
    applyImportant(nodes)
  }

  let node: Rule = {
    kind: 'rule',
    selector: `.${escape(rawCandidate)}`,
    nodes,
  }

  for (let variant of candidate.variants) {
    let result = applyVariant(node, variant, designSystem.variants)

    // When the variant results in `null`, it means that the variant cannot be
    // applied to the rule. Discard the candidate and continue to the next
    // one.
    if (result === null) return null
  }

  return {
    node,
    propertySort,
  }
}

export function applyVariant(node: Rule, variant: Variant, variants: Variants): null | void {
  if (variant.kind === 'arbitrary') {
    node.nodes = [rule(variant.selector, node.nodes)]
    return
  }

  // Safety: At this point it is safe to use TypeScript's non-null assertion
  // operator because if the `candidate.root` didn't exist, `parseCandidate`
  // would have returned `null` and we would have returned early resulting in
  // not hitting this code path.
  let { applyFn } = variants.get(variant.root)!

  if (variant.kind === 'compound') {
    // Some variants traverse the AST to mutate the nodes. E.g.: `group-*` wants
    // to prefix every selector of the variant it's compounding with `.group`.
    //
    // E.g.:
    // ```
    // group-hover:[&_p]:flex
    // ```
    //
    // Should only prefix the `group-hover` part with `.group`, and not the `&_p` part.
    //
    // To solve this, we provide an isolated placeholder node to the variant.
    // The variant can now apply its logic to the isolated node without
    // affecting the original node.
    let isolatedNode = rule('@slot', [])

    let result = applyVariant(isolatedNode, variant.variant, variants)
    if (result === null) return null

    for (let child of isolatedNode.nodes) {
      // Only some variants wrap children in rules. For example, the `force`
      // variant is a noop on the AST. And the `has` variant modifies the
      // selector rather than the children.
      //
      // This means `child` may be a declaration and we don't want to apply the
      // variant to it. This also means the entire variant as a whole is not
      // applicable to the rule and should generate nothing.
      if (child.kind !== 'rule') return null

      let result = applyFn(child as Rule, variant)
      if (result === null) return null
    }

    // Replace the placeholder node with the actual node
    {
      walk(isolatedNode.nodes, (child) => {
        if (child.kind === 'rule' && child.nodes.length <= 0) {
          child.nodes = node.nodes
          return WalkAction.Skip
        }
      })
      node.nodes = isolatedNode.nodes
    }
    return
  }

  // All other variants
  let result = applyFn(node, variant)
  if (result === null) return null
}

function compileBaseUtility(candidate: Candidate, designSystem: DesignSystem) {
  if (candidate.kind === 'arbitrary') {
    let value: string | null = candidate.value

    // Assumption: If an arbitrary property has a modifier, then we assume it
    // is an opacity modifier.
    if (candidate.modifier) {
      value = asColor(value, candidate.modifier, designSystem.theme)
    }

    if (value === null) return

    return [decl(candidate.property, value)]
  }

  let utilities = designSystem.utilities.get(candidate.root) ?? []

  for (let i = utilities.length - 1; i >= 0; i--) {
    let utility = utilities[i]

    if (candidate.kind !== utility.kind) continue

    let compiledNodes = utility.compileFn(candidate)
    if (compiledNodes === null) return null
    if (compiledNodes) return compiledNodes
  }

  return null
}

function applyImportant(ast: AstNode[]): void {
  for (let node of ast) {
    // Skip any `@at-root` rules — we don't want to make the contents of things
    // like `@keyframes` or `@property` important.
    if (node.kind === 'rule' && node.selector === '@at-root') {
      continue
    }

    if (node.kind === 'declaration') {
      node.important = true
    } else if (node.kind === 'rule') {
      applyImportant(node.nodes)
    }
  }
}

function getPropertySort(nodes: AstNode[]): [number[], number[]] {
  // Determine sort order based on properties used
  let propertySort = new Map<number, number>()
  let q: AstNode[] = nodes.slice()

  while (q.length > 0) {
    // Safety: At this point it is safe to use TypeScript's non-null assertion
    // operator because we guarded against `q.length > 0` above.
    let node = q.shift()!
    if (node.kind === 'declaration') {
      if (node.property === '--tw-sort') {
        let idx = GLOBAL_PROPERTY_ORDER.indexOf(node.value)
        if (idx !== -1) {
          propertySort.set(idx, (propertySort.get(idx) ?? 0) + 1)
          break
        }
      }

      let idx = GLOBAL_PROPERTY_ORDER.indexOf(node.property)
      if (idx !== -1) propertySort.set(idx, (propertySort.get(idx) ?? 0) + 1)
    } else if (node.kind === 'rule') {
      // Don't consider properties within `@at-root` when determining the sort
      // order for a rule.
      if (node.selector === '@at-root') continue

      for (let child of node.nodes) {
        q.push(child)
      }
    }
  }

  let sorted = Array.from(propertySort).sort(([a, _a], [z, _z]) => a - z)

  return [
    sorted.map(([propertySort]) => propertySort),
    sorted.map(([, propertyCount]) => propertyCount),
  ]
}
