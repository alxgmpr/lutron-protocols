#!/usr/bin/env python3
"""Extract the full class model from CommunicationFramework.xcclassmodel.

Parses the NSKeyedArchiver binary plist and outputs a structured view of:
- Classes with inheritance hierarchy
- Interfaces (protocols)
- Enums and data types
- Stereotypes (annotations)
"""

import plistlib
import sys
from pathlib import Path

ELEMENTS_PATH = Path(__file__).parent.parent / "Energi Savr.app" / "Wrapper" / "Energi Savr.app" / "CommunicationFramework.xcclassmodel" / "elements"


def load_archive(path: Path) -> tuple[list, dict]:
    with open(path, "rb") as f:
        data = plistlib.load(f)
    return data["$objects"], data.get("$top", {})


def resolve(objects: list, uid):
    if isinstance(uid, plistlib.UID):
        return objects[uid.data]
    return uid


def resolve_name(objects: list, obj) -> str:
    if isinstance(obj, plistlib.UID):
        obj = objects[obj.data]
    if isinstance(obj, dict) and "_name" in obj:
        return resolve_name(objects, obj["_name"])
    if isinstance(obj, str):
        return obj if obj != "$null" else ""
    return str(obj)


def get_classname(objects: list, obj: dict) -> str:
    cls = obj.get("$class")
    if cls:
        cls_obj = resolve(objects, cls)
        if isinstance(cls_obj, dict):
            return cls_obj.get("$classname", "")
    return ""


def extract_set_items(objects: list, bucket_storage) -> list:
    storage = resolve(objects, bucket_storage)
    if not isinstance(storage, dict):
        return []
    items = storage.get("NS.objects", [])
    return [resolve(objects, item) for item in items]


def extract_model(objects: list):
    classes = {}
    interfaces = {}
    data_types = {}
    stereotypes = {}
    generalizations = []

    for i, obj in enumerate(objects):
        if not isinstance(obj, dict):
            continue
        classname = get_classname(objects, obj)

        if classname == "XDSCClass":
            name = resolve_name(objects, obj.get("_name", ""))
            if not name:
                continue
            is_abstract = obj.get("_isAbstract", False)

            # Inheritance
            parents = []
            gen_items = extract_set_items(objects, obj.get("XDBucketForGeneralizationsstorage"))
            for gen in gen_items:
                if isinstance(gen, dict):
                    general = resolve(objects, gen.get("_general"))
                    if isinstance(general, dict):
                        parent_name = resolve_name(objects, general.get("_name", ""))
                        if parent_name:
                            parents.append(parent_name)

            # Children (specializations)
            children = []
            spec_items = extract_set_items(objects, obj.get("XDBucketForSpecializationsstorage"))
            for spec in spec_items:
                if isinstance(spec, dict):
                    specific = resolve(objects, spec.get("_specific"))
                    if isinstance(specific, dict):
                        child_name = resolve_name(objects, specific.get("_name", ""))
                        if child_name:
                            children.append(child_name)

            # Implemented interfaces
            ifaces = []
            iface_items = extract_set_items(objects, obj.get("XDBucketForImplementedInterfacesstorage"))
            for iface in iface_items:
                if isinstance(iface, dict):
                    iface_name = resolve_name(objects, iface.get("_name", ""))
                    if iface_name:
                        ifaces.append(iface_name)

            # Stereotypes
            stereo_list = []
            stereo_items = extract_set_items(objects, obj.get("XDBucketForStereotypesstorage"))
            for s in stereo_items:
                if isinstance(s, dict):
                    s_name = resolve_name(objects, s.get("_name", ""))
                    if s_name:
                        stereo_list.append(s_name)

            classes[name] = {
                "abstract": is_abstract,
                "parents": parents,
                "children": children,
                "interfaces": ifaces,
                "stereotypes": stereo_list,
                "index": i,
            }

        elif classname == "XDSCInterface":
            name = resolve_name(objects, obj.get("_name", ""))
            if not name:
                continue

            # Implementing classes
            impl_classes = []
            impl_items = extract_set_items(objects, obj.get("XDBucketForImplementingClassifiersstorage"))
            for impl in impl_items:
                if isinstance(impl, dict):
                    impl_name = resolve_name(objects, impl.get("_name", ""))
                    if impl_name:
                        impl_classes.append(impl_name)

            interfaces[name] = {
                "implementors": impl_classes,
                "index": i,
            }

        elif classname == "XDUMLDataTypeImp":
            name = resolve_name(objects, obj.get("_name", ""))
            if name:
                data_types[name] = {"index": i}

        elif classname == "XDUMLStereotypeImp":
            name = resolve_name(objects, obj.get("_name", ""))
            if name:
                stereotypes[name] = {"index": i}

    return classes, interfaces, data_types, stereotypes


def build_tree(classes: dict) -> dict[str, list[str]]:
    """Build parent -> children mapping."""
    tree: dict[str, list[str]] = {}
    for name, info in classes.items():
        if not info["parents"]:
            tree.setdefault("(root)", []).append(name)
        for parent in info["parents"]:
            tree.setdefault(parent, []).append(name)
    for children in tree.values():
        children.sort()
    return tree


def print_tree(tree: dict, classes: dict, node: str, indent: int = 0):
    prefix = "  " * indent
    marker = " (abstract)" if node in classes and classes[node]["abstract"] else ""
    ifaces = classes.get(node, {}).get("interfaces", [])
    iface_str = f" <{', '.join(ifaces)}>" if ifaces else ""
    stereos = classes.get(node, {}).get("stereotypes", [])
    stereo_str = f" [{', '.join(stereos)}]" if stereos else ""
    print(f"{prefix}- {node}{marker}{iface_str}{stereo_str}")
    for child in tree.get(node, []):
        print_tree(tree, classes, child, indent + 1)


def main():
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else ELEMENTS_PATH
    if not path.exists():
        print(f"Error: {path} not found", file=sys.stderr)
        sys.exit(1)

    objects, top = load_archive(path)
    classes, interfaces, data_types, stereotypes = extract_model(objects)

    print("=" * 70)
    print("CommunicationFramework Class Model")
    print(f"  Source: Energi Savr.app (ESN-QS, Lutron 2009)")
    print(f"  Classes: {len(classes)}")
    print(f"  Interfaces: {len(interfaces)}")
    print(f"  Data Types: {len(data_types)}")
    print("=" * 70)

    # Inheritance tree
    print("\n## Class Hierarchy\n")
    tree = build_tree(classes)
    roots = tree.get("(root)", [])
    # Print classes that ARE parents first (top of hierarchy)
    printed = set()
    for root in sorted(roots):
        if root in tree:  # has children = parent class
            print_tree(tree, classes, root)
            printed.add(root)
            for child in tree.get(root, []):
                printed.add(child)
    # Then orphan roots (no children, no parents)
    orphans = [r for r in roots if r not in printed]
    if orphans:
        print("\n### Standalone Classes\n")
        for name in sorted(orphans):
            info = classes[name]
            ifaces = info.get("interfaces", [])
            iface_str = f" <{', '.join(ifaces)}>" if ifaces else ""
            print(f"  - {name}{iface_str}")

    # Interfaces
    if interfaces:
        print("\n## Interfaces (Protocols)\n")
        for name in sorted(interfaces):
            info = interfaces[name]
            impls = info["implementors"]
            impl_str = f" -> {', '.join(sorted(impls))}" if impls else ""
            print(f"  - {name}{impl_str}")

    # Data types / Enums
    if data_types:
        print("\n## Data Types & Enums\n")
        # Separate enums from primitives
        enums = sorted(n for n in data_types if n.endswith("_ENUM") or n[0].isupper() and not any(c in n for c in "* "))
        primitives = sorted(n for n in data_types if n not in enums)
        if enums:
            print("### Application Enums\n")
            for name in sorted(enums):
                print(f"  - {name}")
        if primitives:
            print("\n### Primitive/System Types\n")
            for name in sorted(primitives):
                print(f"  - {name}")

    # Full class detail
    print("\n## Class Details\n")
    for name in sorted(classes):
        info = classes[name]
        parts = [f"### {name}"]
        if info["abstract"]:
            parts[0] += " (abstract)"
        details = []
        if info["parents"]:
            details.append(f"  Extends: {', '.join(info['parents'])}")
        if info["children"]:
            details.append(f"  Subclasses: {', '.join(sorted(info['children']))}")
        if info["interfaces"]:
            details.append(f"  Implements: {', '.join(info['interfaces'])}")
        if info["stereotypes"]:
            details.append(f"  Stereotypes: {', '.join(info['stereotypes'])}")
        if details:
            print(parts[0])
            for d in details:
                print(d)
            print()


if __name__ == "__main__":
    main()
