import { indexCatalog } from "./catalog.mjs";

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function tarjan(nodes, edges) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indexes = new Map();
  const low = new Map();
  const groups = [];

  function visit(node) {
    indexes.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const next of edges.get(node) || []) {
      if (!indexes.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), indexes.get(next)));
      }
    }

    if (low.get(node) === indexes.get(node)) {
      const group = [];
      for (;;) {
        const member = stack.pop();
        onStack.delete(member);
        group.push(member);
        if (member === node) break;
      }
      groups.push(group.sort());
    }
  }

  for (const node of [...nodes].sort()) {
    if (!indexes.has(node)) visit(node);
  }

  return groups;
}

function orderGroups(groups, edges) {
  const groupOf = new Map();
  groups.forEach((group, i) => group.forEach((node) => groupOf.set(node, i)));

  const outgoing = groups.map(() => new Set());
  const indegree = groups.map(() => 0);

  for (const [from, tos] of edges) {
    const fromGroup = groupOf.get(from);
    for (const to of tos) {
      const toGroup = groupOf.get(to);
      if (fromGroup !== toGroup && !outgoing[fromGroup].has(toGroup)) {
        outgoing[fromGroup].add(toGroup);
        indegree[toGroup] += 1;
      }
    }
  }

  const key = (i) => groups[i].join(",");
  const ready = [];
  indegree.forEach((value, i) => {
    if (value === 0) ready.push(i);
  });
  ready.sort((a, b) => key(a).localeCompare(key(b)));

  const ordered = [];
  while (ready.length) {
    const current = ready.shift();
    ordered.push(groups[current]);
    for (const next of [...outgoing[current]].sort((a, b) => key(a).localeCompare(key(b)))) {
      indegree[next] -= 1;
      if (indegree[next] === 0) {
        ready.push(next);
        ready.sort((a, b) => key(a).localeCompare(key(b)));
      }
    }
  }

  if (ordered.length !== groups.length) {
    throw new Error("Internal resolver error: SCC condensation graph is cyclic");
  }

  return ordered;
}

export function resolveSelection(catalog, requestedValues, scopes = ["runtime"]) {
  const { byId, aliases } = indexCatalog(catalog);
  const allowedScopes = new Set(catalog.dependencyScopes);

  const normalizedScopes = uniqueSorted(scopes);
  for (const scope of normalizedScopes) {
    if (!allowedScopes.has(scope)) {
      throw new Error(`Unknown dependency scope: ${scope}`);
    }
  }

  const normalize = (value) => {
    const id = aliases.get(String(value).toLowerCase());
    if (!id) throw new Error(`Unknown ESsemble component: ${value}`);
    return id;
  };

  const requested = uniqueSorted(requestedValues.map(normalize));
  const selected = new Set(requested);
  const queue = [...requested];

  while (queue.length) {
    const id = queue.shift();
    const component = byId.get(id);
    for (const scope of normalizedScopes) {
      for (const dependency of component.dependencies[scope] || []) {
        const dependencyId = normalize(dependency);
        if (!selected.has(dependencyId)) {
          selected.add(dependencyId);
          queue.push(dependencyId);
        }
      }
    }
  }

  const nodes = [...selected].sort();
  const edges = new Map(nodes.map((id) => [id, new Set()]));

  // Build dependency -> consumer edges so topological groups are construction ordered.
  for (const consumerId of nodes) {
    const consumer = byId.get(consumerId);
    for (const scope of normalizedScopes) {
      for (const dependency of consumer.dependencies[scope] || []) {
        const dependencyId = normalize(dependency);
        if (selected.has(dependencyId)) {
          edges.get(dependencyId).add(consumerId);
        }
      }
    }
  }

  const groups = orderGroups(tarjan(nodes, edges), edges);
  const cycles = groups.filter((group) => group.length > 1);

  return {
    requested,
    scopes: normalizedScopes,
    components: nodes,
    groups,
    cycles
  };
}
