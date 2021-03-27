// node ./analyze-trace.js vendor/mui/trace.json vendor/mui/types.json --json output.json

type Opts = {
    json?: string, 
    thresholdDuration?: string
    minDuration?: string
    minPercentage?: string
}

const args: string[] = []
const opts: Opts  = {}

let foundOpt: string | undefined = undefined
process.argv.forEach((arg, i) => {
    if (foundOpt) {
        opts[foundOpt] = arg
        foundOpt = undefined
        return
    }

    if (arg.startsWith("--")) {
        foundOpt = arg.replace("--", "")
    } else {
        args.push(arg)
    }
});

if (args.length !== 3 && args.length != 4) {
    const path = require("path");
    console.error(`Usage: ${path.basename(process.argv[0])} ${path.basename(process.argv[1])} trace_path [type_path]`);
    console.error(`Options:  --json              [path]           Prints a JSON object of the results to stdout`);
    console.error(`          --thresholdDuration [default: 50000] How many ms should a span with children use for highlighting`);
    console.error(`          --minDuration       [default: 10000] How long should a single span take before being classed as interesting`);
    console.error(`          --minPercentage     [default: 0.6]   The threshold for being interesting based on % of call stack`);
    process.exit(1);
}

import { assert } from "console";
import chalk = require("chalk");
import treeify = require("treeify");
import fs = require("fs");
import path = require("path");

import getTypeTree = require("./get-type-tree");
import normalizePositions = require("./normalize-positions");

const Parser = require("jsonparse");

const tracePath = process.argv[2];
const typesPath = process.argv[3];

if (!fs.existsSync(tracePath)) {
    console.error(`${tracePath} does not exist`);
    process.exit(2);
}

if (typesPath && !fs.existsSync(typesPath)) {
    console.error(`${typesPath} does not exist`);
    process.exit(3);
}

const thresholdDuration = Number(opts.thresholdDuration) || 5E5; // microseconds
const minDuration = Number(opts.minDuration) || 1E5; // microseconds
const minPercentage = Number(opts.minPercentage) || 0.6;

main().catch(err => console.error(`Internal Error: ${err.message}\n${err.stack}`));

type LineChar = normalizePositions.LineChar;
type PositionMap = Map<string, Map<string, LineChar>>; // Path to position (offset or LineChar) to LineChar

interface Event {
    ph: string;
    ts: string;
    dur?: string;
    name: string;
    cat: string;
    args?: any;
}

interface EventSpan {
    event?: Event;
    start: number;
    end: number;
    children: EventSpan[];
    typeTree?: any;
}

interface ParseResult {
    minTime: number;
    maxTime: number;
    spans: EventSpan[];
    unclosedStack: Event[];
}

function parse(tracePath: string): Promise<ParseResult> {
    return new Promise<ParseResult>(resolve => {
        const p = new Parser();

        let minTime = Infinity;
        let maxTime = 0;
        const unclosedStack: Event[] = []; // Sorted in increasing order of start time (even when below timestamp resolution)
        const spans: EventSpan[] = []; // Sorted in increasing order of end time, then increasing order of start time (even when below timestamp resolution)
        p.onValue = function (value: any) {
            if (this.stack.length !== 1) return;
            assert(this.mode === Parser.C.ARRAY, `Unexpected mode ${this.mode}`);
            this.value = [];

            // Metadata objects are uninteresting
            if (value.ph === "M") return;

            // TODO (https://github.com/amcasey/ts-analyze-trace/issues/1)
            if (value.ph === "i" || value.ph === "I") return;

            const event = value as Event;

            if (event.ph === "B") {
                unclosedStack.push(event);
                return;
            }

            let span: EventSpan;
            if (event.ph === "E") {
                const beginEvent = unclosedStack.pop()!;
                span = { event: beginEvent, start: +beginEvent.ts, end: +event.ts, children: [] };
            }
            else if (event.ph === "X") {
                const start = +event.ts;
                const duration = +event.dur!;
                span = { event, start, end: start + duration, children: [] }
            }
            else {
                assert(false, `Unknown event phase ${event.ph}`);
                return;
            }

            minTime = Math.min(minTime, span.start);
            maxTime = Math.max(maxTime, span.end);

            if ((span.end - span.start) >= minDuration) {
                spans.push(span);
            }
        }

        const readStream = fs.createReadStream(tracePath);
        readStream.on("data", chunk => p.write(chunk));
        readStream.on("end", () => {
            resolve({
                minTime,
                maxTime,
                spans: spans,
                unclosedStack: unclosedStack,
            });
        });
    });
}


async function main(): Promise<void> {
    const { minTime, maxTime, spans, unclosedStack } = await parse(tracePath);
    if (unclosedStack.length) {
        console.log("Trace ended unexpectedly");

        while (unclosedStack.length) {
            const event = unclosedStack.pop()!;
            console.log(`> ${event.name}: ${JSON.stringify(event.args)}`);
            spans.push({ event, start: +event.ts, end: maxTime, children: [] });
        }

        console.log();
    }

    spans.sort((a, b) => a.start - b.start);

    const root: EventSpan = { start: minTime, end: maxTime, children: [] };
    const stack = [ root ];

    for (const span of spans) {
        let i = stack.length - 1;
        for (; i > 0; i--) { // No need to check root at stack[0]
            const curr = stack[i];
            if (curr.end > span.start) {
                // Pop down to parent
                stack.length = i + 1;
                break;
            }
        }

        const parent = stack[i];
        const duration = span.end - span.start;
        if (duration >= thresholdDuration || duration >= minPercentage * (parent.end - parent.start)) {
            parent.children.push(span);
            stack.push(span);
        }
    }

    await makeHotStacks(root);
}

type TreeNode = {
    type: string
    time?: string
    message: string
    terseMessage: string
    start?: {
        file: string
        offset?: number
    },
    end?: {
        file: string
        offset?: number
    }
    children: TreeNode[]
}

async function makeHotStacks(root: EventSpan): Promise<void> {
    if (typesPath) {
        await addTypeTrees(root);
    }

    const positionMap = await getNormalizedPositions(root);

    const tree = await makePrintableTree(root, /*currentFile*/ undefined, positionMap);
    
    if (tree && Object.entries(tree).length) {    
        if (opts.json) {
            fs.writeFileSync(opts.json, JSON.stringify(tree, null, "  "))
        }
        console.log("Hot Spots");
        const consoleTree = treeNodeToTreeifyTree(tree!)
        console.log(treeify.asTree(consoleTree, /*showValues*/ false, /*hideFunctions*/ true));
    }
    else {
        console.log("No hot spots found")
    }
}

async function addTypeTrees(root: EventSpan): Promise<void> {
    const stack: EventSpan[] = [];
    stack.push(root);

    while(stack.length) {
        const curr = stack.pop()!;
        if (curr.children.length === 0 && curr.event?.name === "structuredTypeRelatedTo") {
            const types = await getTypes();
            if (types.length) {
                curr.typeTree = {
                    ...getTypeTree(types, curr.event.args!.sourceId),
                    ...getTypeTree(types, curr.event.args!.targetId),
                };
            }
        }

        stack.push(...curr.children); // Order doesn't matter during this traversal
    }
}

async function getNormalizedPositions(root: EventSpan): Promise<PositionMap> {
    const positionMap = new Map<string, (number | LineChar)[]>();
    recordPositions(root, /*currentFile*/ undefined);

    const map = new Map<string, Map<string, LineChar>>(); // NB: can't use LineChar as map key
    for (const entry of Array.from(positionMap.entries())) {
        try {
            const path = entry[0];
            const sourceStream = fs.createReadStream(path, { encoding: "utf-8" });

            const rawPositions = entry[1];
            const normalizedPositions = await normalizePositions(sourceStream, rawPositions);

            const pathMap = new Map<string, LineChar>();
            for (let i = 0; i < rawPositions.length; i++) {
                const rawPosition = rawPositions[i];
                const key = typeof rawPosition === "number" ? Math.abs(rawPosition).toString() : getLineCharMapKey(...rawPosition as LineChar);
                pathMap.set(key, normalizedPositions[i]);
            }

            map.set(path, pathMap);
        } catch {
            // Not finding a file is expected if this isn't the box on which the trace was recorded.
        }
    }

    return map;

    function recordPositions(span: EventSpan, currentFile: string | undefined): void {
        if (span.event?.name === "checkSourceFile") {
            currentFile = span.event!.args!.path;
        }
        else if (currentFile && span.event?.cat === "check") {
            const args = span.event.args;
            if (args?.pos) {
                recordPosition(currentFile, args.pos);
            }
            if (args?.end) {
                recordPosition(currentFile, -args.end); // Negative since end should not be moved past trivia
            }
        }

        for (const child of span.children) {
            recordPositions(child, currentFile);
        }

        recordPositionsInTypeTree(span.typeTree);
    }

    function recordPositionsInTypeTree(typeTree: any): void {
        if (!typeTree) return;

        for (const typeString in typeTree) {
            const type = JSON.parse(typeString);
            if (type.location) {
                const location = type.location;
                recordPosition(location.path, [ location.line, location.char ]);
            }

            recordPositionsInTypeTree(typeTree[typeString]);
        }
    }

    function recordPosition(path: string, position: number | LineChar): void {
        if (!positionMap.has(path)) {
            positionMap.set(path, []);
        }

        positionMap.get(path)!.push(position);
    }
}

let typesCache: undefined | readonly any[];
async function getTypes(): Promise<readonly any[]> {
    if (!typesCache) {
        try {
            const json = await fs.promises.readFile(typesPath, { encoding: "utf-8" });
            typesCache = JSON.parse(json);
        }
        catch (e) {
            console.error(`Error reading types file: ${e.message}`);
            typesCache = [];
        }
    }

    return typesCache!;
}

async function makePrintableTree(curr: EventSpan, currentFile: string | undefined, positionMap: PositionMap): Promise<TreeNode | undefined> {
    if (curr.event?.name === "checkSourceFile") {
        currentFile = curr.event.args!.path;
    }

    const node = eventToTreeNode();
    if (node) {
        node.time = `${Math.round((curr.end - curr.start) / 1000)}ms`
        
        if (curr.children.length) {
            const sortedChildren = curr.children.sort((a, b) => (b.end - b.start) - (a.end - a.start));
            const nodes: TreeNode[] = []

            for (const child of sortedChildren) {
                const tree = await makePrintableTree(child, currentFile, positionMap)
                if (tree) nodes.push(tree)
            }

            node.children = nodes
        }
    }

    if (curr.typeTree && node) {
       updateTypeTreePositions(node, curr.typeTree);
    }

    return node;

    function eventToTreeNode(): TreeNode | undefined {
        const treeNode: TreeNode = {
            message: "",
            terseMessage: "",
            type: "hot-spots",
            children: [],
            start: {
                file: currentFile!
            }
        }
        if (!curr.event) return treeNode

        const event = curr.event;
        treeNode.type = event.name
        switch (event.name) {
            // TODO (https://github.com/amcasey/ts-analyze-trace/issues/2)
            // case "findSourceFile":
            //     return `Load file ${event.args!.fileName}`;
            // TODO (https://github.com/amcasey/ts-analyze-trace/issues/3)
            // case "emit":
            //     return `Emit`;
            case "checkSourceFile":
                treeNode.message = `Check file ${formatPath(currentFile!)}`
                treeNode.terseMessage = `Check file ${path.basename(currentFile!)}`
                return treeNode

            case "structuredTypeRelatedTo":
                const args = event.args!;
                treeNode.message = `Compare types ${args.sourceId} and ${args.targetId}`;
                treeNode.terseMessage = `Compare types ${args.sourceId} and ${args.targetId}`;
                // TODO: Add start and end links
                return 

            case "getVariancesWorker":
                treeNode.message = `Compute variance of type ${event.args!.id}`;
                treeNode.terseMessage = `Compute variance of type ${event.args!.id}`;
                return 

            default:
                if (event.cat === "check" && event.args && event.args.pos && event.args.end) {
                    if (positionMap.has(currentFile!)) {
                        const updatedPos = positionMap.get(currentFile!)!.get(event.args.pos.toString())!;
                        const updatedEnd = positionMap.get(currentFile!)!.get(event.args.end.toString())!;
                        treeNode.message =  `${unmangleCamelCase(event.name)} from (line ${updatedPos[0]}, char ${updatedPos[1]}) to (line ${updatedEnd[0]}, char ${updatedEnd[1]})`;
                        treeNode.terseMessage = unmangleCamelCase(event.name);
                        treeNode.start = {
                            file: currentFile!,
                            offset: event.args.pos,
                        }
                        treeNode.end = {
                            file: currentFile!,
                            offset: event.args.end,
                        }
                        return treeNode;
                    }
                    else {
                        treeNode.message = `${unmangleCamelCase(event.name)} from offset ${event.args.pos} to offset ${event.args.end}`
                        treeNode.terseMessage = unmangleCamelCase(event.name);
                        return treeNode;
                    }
                }
                return undefined;
        }
    }

    function updateTypeTreePositions(node: TreeNode, typeTree: any): any {
        if (!typeTree) return;

        let newTree = {};
        for (let typeString in typeTree) {
            const subtree = typeTree[typeString];

            const type = JSON.parse(typeString);
            if (type.location) {
                const path = type.location.path;
                if (positionMap.has(path)) {
                    const updatedPosition = positionMap.get(path)!.get(getLineCharMapKey(type.location.line, type.location.char))!;
                    [ type.location.line, type.location.char ] = updatedPosition;

                    typeString = JSON.stringify(type);
                }

                typeString = typeString.replace(path, formatPath(path));
            }

            newTree[typeString] = updateTypeTreePositions(node, subtree);
        }

        return newTree;
    }
}

function formatPath(p: string) {
    if (/node_modules/.test(p)) {
        p = p.replace(/\/node_modules\/([^@][^/]+)\//g, `/node_modules/${chalk.cyan("$1")}/`);
        p = p.replace(/\/node_modules\/(@[^/]+\/[^/]+)/g, `/node_modules/${chalk.cyan("$1")}/`);
    }
    else {
        p = path.join(path.dirname(p), chalk.cyan(path.basename(p)));
    }
    return chalk.magenta(path.normalize(p));
}

function unmangleCamelCase(name: string) {
    let result = "";
    for (const char of [...<any>name]) {
        if (!result.length) {
            result += char.toLocaleUpperCase();
            continue;
        }

        const lower = char.toLocaleLowerCase();
        if (char !== lower) {
            result += " ";
        }

        result += lower;
    }
    return result;
}

function getLineCharMapKey(line: number, char: number) {
    return `${line},${char}`;
}

function treeNodeToTreeifyTree(node: TreeNode) {
    const obj = {}
    const toKey = (node: TreeNode) => `${node.message} (${node.time})`

    let value: any | null = null
    if (node.children){
        let newValue = {}
        node.children.forEach(c => {
             newValue[toKey(c)] = treeNodeToTreeifyTree(c)
        });
        value = newValue
    }
    obj[toKey(node)] = value

    return obj
}
