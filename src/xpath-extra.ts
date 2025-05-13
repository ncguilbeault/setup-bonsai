// This file provides a thin wrapper around xpath to work around https://github.com/goto100/xpath/issues/144 and expose some functionality
// that is not properly exposed by the TypeScript definitions. It also adds some helpers to make it easier to convey the type of node you're expecting from your expression.
// It probably would've made more sense to use a different xpath library instead (xpath-ts was considered but didn't appear mature), but unfortunately this seems to be
// *the* library despite having gone a bit stale. Nobody likes XML anymore :(
import * as xmldom from '@xmldom/xmldom';
import * as xpath from 'xpath';

// The official xpath type definitions are missing all the advanced APIs, we define a minimum subset to get what we need.
declare module 'xpath' {
    export type XPathEvaluateOptions = {
        variables?: object; // Note that this supports functions as well, just didn't bother with the type definition

        node: xmldom.Node;
        allowAnyNamespaceForNoPrefix?: boolean;
        isHtml?: boolean;
    }

    class XPath {
    }

    export class XString {
        public stringValue(): string;
    }

    export class XNumber {
        public numberValue(): number;
    }

    export class XBoolean {
        public booleanValue(): boolean;
    }

    export class XNodeSet {
        // Returns an array of the node set's contents in document order
        public toArray(): xmldom.Node[];

        // Returns the first node in the set
        public first(): xmldom.Node | null;
    }

    // This set is implied by the XPathResult constructor
    export type EvaluateResult = XString | XNumber | XBoolean | XNodeSet;

    export interface XPathEvaluator {
        expression: XPath | undefined;
        evaluate(options?: XPathEvaluateOptions): EvaluateResult;
    }

    export function parse(xpath: string): XPathEvaluator;
}

export function nodeTypeToString(nodeType: number): string {
    switch (nodeType) {
        case xmldom.Node.ELEMENT_NODE: return 'element';
        case xmldom.Node.ATTRIBUTE_NODE: return 'attribute';
        case xmldom.Node.TEXT_NODE: return 'text node';
        case xmldom.Node.CDATA_SECTION_NODE: return 'CDATA section';
        case xmldom.Node.PROCESSING_INSTRUCTION_NODE: return 'processing instruction';
        case xmldom.Node.COMMENT_NODE: return 'comment';
        case xmldom.Node.DOCUMENT_NODE: return 'document';
        case xmldom.Node.DOCUMENT_TYPE_NODE: return 'doctype';
        case xmldom.Node.DOCUMENT_FRAGMENT_NODE: return 'document fragment';

        case xmldom.Node.ENTITY_REFERENCE_NODE: return 'entity reference (deprecated)';
        case xmldom.Node.ENTITY_NODE: return 'entity node (deprecated)';
        case xmldom.Node.NOTATION_NODE: return 'notation node (deprecated)';
        default: return `nodeType_${nodeType}`;
    }
}

export class SelectOptions {
    variables?: object;
}

function selectNodeSet(
    expression: string | xpath.XPathEvaluator,
    node: xmldom.Node,
    selectOptions?: SelectOptions
): xpath.EvaluateResult {
    if (typeof expression === 'string') {
        expression = xpath.parse(expression);
    }

    let options: xpath.XPathEvaluateOptions = {
        ...selectOptions,
        node: node,
        // This enables using xpath with nodes lacking a namespace prefix when the document has a default namespace
        // (Following the xpath 1.0 spec to a T normally doesn't allow this.)
        allowAnyNamespaceForNoPrefix: true,
        // The "HTML" hint enables allowAnyNamespaceForNoPrefix and (more importantly) case insensitivity
        // This is consistent with how NuGet parses various XML files and with the default xpath.select functions.
        isHtml: true,
    };

    return expression.evaluate(options);
}

export function selectElements(expression: string | xpath.XPathEvaluator, node: xmldom.Node, options?: SelectOptions): xmldom.Element[] {
    const result = selectNodeSet(expression, node, options);

    if (result.constructor !== xpath.XNodeSet) {
        throw Error(`Error evaluating '${expression}', expected node set but got ${result.constructor.name}.`);
    }

    const nodes = result.toArray();

    let badNode = nodes.find(n => n.nodeType != xmldom.Node.ELEMENT_NODE);
    if (badNode) {
        throw Error(`Error evaluating '${expression}', expected array of elements but got ${nodeTypeToString(badNode.nodeType)} (and possibly others.)`);
    }

    return <xmldom.Element[]>nodes;
}

function checkedSelect1<T extends xmldom.Node>(
    expression: string | xpath.XPathEvaluator,
    node: xmldom.Node,
    expectedType: number | null,
    selectOptions?: SelectOptions
): T | null {
    const result = selectNodeSet(expression, node, selectOptions);

    // Handle expressions that don't produce nodes at all
    if (result.constructor !== xpath.XNodeSet) {
        throw Error(`Error evaluating '${expression}', expected ${expectedType === null ? 'node' : nodeTypeToString(expectedType)} but got ${result.constructor.name}.`);
    }

    const resultNode = result.first();
    if (resultNode === null) {
        return null;
    } else if (expectedType === null || resultNode.nodeType === expectedType) {
        return <T>resultNode;
    } else if (resultNode.nodeType) {
        throw Error(`Error evaluating '${expression}', expected ${nodeTypeToString(expectedType)} but got ${nodeTypeToString(resultNode.nodeType)}.`);
    } else {
        throw Error(`Error evaluating '${expression}', expected ${nodeTypeToString(expectedType)} but got a nonsensical result.`);
    }
}

export function select1Node(expression: string | xpath.XPathEvaluator, node: xmldom.Node, options?: SelectOptions): xmldom.Node | null {
    return checkedSelect1(expression, node, null, options);
}

export function select1Attribute(expression: string | xpath.XPathEvaluator, node: xmldom.Node, options?: SelectOptions): xmldom.Attr | null {
    return checkedSelect1(expression, node, xmldom.Node.ATTRIBUTE_NODE, options);
}

export function select1Element(expression: string | xpath.XPathEvaluator, node: xmldom.Node, options?: SelectOptions): xmldom.Element | null {
    return checkedSelect1(expression, node, xmldom.Node.ELEMENT_NODE, options);
}

export function select1Text(expression: string | xpath.XPathEvaluator, node: xmldom.Node, options?: SelectOptions): xmldom.Text | null {
    return checkedSelect1(expression, node, xmldom.Node.TEXT_NODE, options);
}

export function parse(expression: string): xpath.XPathEvaluator {
    const result = xpath.parse(expression);
    if (!result.expression) {
        throw Error(`Failed to parse xpath expression '${expression}'`);
    }

    return result;
}

export function smartRemove(node: xmldom.Element): void {
    if (!node.parentNode) {
        throw Error(`Tried to remove already oprhaned node '${node.nodeName}'`);
    }

    // The sibling text node prior to this node is effectively the indentation for this node, so we want to remove it while we're at it.
    let textSibling = node.previousSibling;
    if (textSibling?.nodeType === xmldom.Node.TEXT_NODE) {
        node.parentNode.removeChild(textSibling);
    }

    node.parentNode.removeChild(node);
}
