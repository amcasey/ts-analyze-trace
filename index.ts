const args: string[] = []
const opts: string[] = []

let foundOpt: string | undefined = undefined
process.argv.forEach((arg, i) => {
    if (foundOpt) {
        opts.push(foundOpt, arg)
        foundOpt = undefined
        return
    }

    if (arg.startsWith("--")) {
        foundOpt = arg
    } else {
        args.push(arg)
    }
});

if (args.length !== 3) {
    const path = require("path");
    console.error(`Usage: ${path.basename(process.argv[0])} ${path.basename(process.argv[1])} trace_dir`);
    console.error(`Options:  --json              [path]           Prints a JSON object of the results to stdout`);
    console.error(`          --thresholdDuration [default: 50000] How many ms should a span with children use for highlighting`);
    console.error(`          --minDuration       [default: 10000] How long should a single span take before being classed as interesting`);
    console.error(`          --minPercentage     [default: 0.6]   The threshold for being interesting based on % of call stack`);
    process.exit(1);
}

import cp = require("child_process");
import fs = require("fs");
import os = require("os");
import crypto = require("crypto");
import path = require("path");

import plimit = require("p-limit");
const limit = plimit(os.cpus().length);

const traceDir = process.argv[2];

if (!fs.existsSync(traceDir) || !fs.statSync(traceDir)?.isDirectory()) {
    console.error(`${traceDir} is not a directory`);
    process.exit(2);
}

main().then(
    value => process.exit(value ? 0 : 3),
    err => {
        console.error(`Internal error: ${err.message}`);
        process.exit(4);
    });

interface Project {
    configFilePath?: string;
    tracePath: string;
    typesPath: string;
}

interface ProjectResult {
    project: Project;
    jsonPath: string | undefined
    stdout: string;
    stderr: string;
    exitCode: number | undefined;
    signal: NodeJS.Signals | undefined;
}

async function main(): Promise<boolean> {
    let projects: undefined | Project[];

    const legendPath = path.join(traceDir, "legend.json");
    if (await isFile(legendPath)) {
        try {
            const legendText = await fs.promises.readFile(legendPath, { encoding: "utf-8" });
            projects = JSON.parse(legendText);

            for (const project of projects!) {
                project.tracePath = path.resolve(traceDir, path.basename(project.tracePath));
                project.typesPath = path.resolve(traceDir, path.basename(project.typesPath));
            }
        }
        catch (e) {
            console.error(`Error reading legend file: ${e.message}`);
        }
    }

    if (!projects) {
        projects = [];

        for (const entry of await fs.promises.readdir(traceDir, { withFileTypes: true })) {
            if (!entry.isFile()) continue;

            const name = entry.name;
            const match = name.match(/^trace(.*\.json)$/);
            if (match) {
                projects.push({
                    tracePath: path.join(traceDir, name),
                    typesPath: path.join(traceDir, `types${match[1]}`),
                });
            }
        }
    }

    return await analyzeProjects(projects);
}

async function analyzeProjects(projects: readonly Project[]): Promise<boolean> {
    const results = await Promise.all(projects.map(p => limit(analyzeProject, p)));

    if (opts.includes("--json")) {
        const writePath = opts[opts.indexOf("--json") + 1]
        const allJSONs = results.map(p => {
            if(!p.jsonPath || !fs.existsSync(p.jsonPath)) return
            return {
                trace: p.project.tracePath,
                configFilePath: p.project.configFilePath,
                repo: JSON.parse(fs.readFileSync(p.jsonPath!, "utf8"))
            }
        }).filter(Boolean)
        fs.writeFileSync(writePath, JSON.stringify(allJSONs, null, "  "))
    }

    const hadHotSpots: (ProjectResult & { score: number })[] = [];
    const hadErrors: ProjectResult[] = [];
    for (const result of results) {
        if (result.stderr || result.exitCode || result.signal) {
            hadErrors.push(result);
            continue;
        }

        // First will be the largest, so only need to match one
        const match = result.stdout.match(/\((\d+)[ ]*ms\)/);
        if (match) {
            hadHotSpots.push({...result, score: +match[1] });
        }
    }

    let first = true;
    const projectCount = projects.length;

    hadHotSpots.sort((a, b) => b.score - a.score); // Descending
    for (const result of hadHotSpots) {
        if (!first) console.log();
        first = false;

        const project = result.project;
        if (projectCount > 1 || project.configFilePath) {
            console.log(`Analyzed ${getProjectDescription(project)}`);
        }
        console.log(result.stdout);
    }

    for (const errorResult of hadErrors) {
        if (!first) console.log();
        first = false;

        const project = errorResult.project;
        console.log(`Error analyzing ${getProjectDescription(project)}`);
        if (errorResult.stderr) {
            console.log(errorResult.stderr);
        }
        else if (errorResult.exitCode) {
            console.log(`Exited with code ${errorResult.exitCode}`);
        }
        else if (errorResult.signal) {
            console.log(`Terminated with signal ${errorResult.signal}`);
        }
    }

    const interestingCount = hadHotSpots.length + hadErrors.length;
    if (interestingCount < projectCount) {
        if (!first) console.log();
        first = false;

        console.log(`Found nothing in ${projectCount - interestingCount}${interestingCount ? " other" : ""} project(s)`);
    }

    return hadErrors.length > 0;
}

function getProjectDescription(project: Project) {
    return project.configFilePath
       ? `${project.configFilePath} (${path.basename(project.tracePath)})`
       : path.basename(project.tracePath);
}

async function analyzeProject(project: Project): Promise<ProjectResult> {
    const args = [ project.tracePath ];
    if (await isFile(project.typesPath)) {
        args.push(project.typesPath);
    }

    // If it's going to include a JSON path, make it per-trace
    let jsonPath: string | undefined = undefined
    if (opts.includes("--json")) {
        const hash = crypto.createHash('sha256').update(project.tracePath).digest("hex");
        jsonPath = path.join(os.tmpdir(), hash + ".json")
    }

    return new Promise<ProjectResult>(resolve => {
        const cmd = path.join(__dirname, "analyze-trace")
        const childArgs = args.concat(opts)
        const child = cp.fork(cmd, childArgs, { stdio: "pipe", env: { FORCE_COLOR: '1' } });

        let stdout = "";
        let stderr = "";

        child.stdout!.on("data", chunk => stdout += chunk);
        child.stderr!.on("data", chunk => stderr += chunk);

        child.on("exit", (code, signal) => {
            resolve({
                project,
                jsonPath,
                stdout: stdout.trim(),
                stderr: stderr.trim(),
                exitCode: code ?? undefined,
                signal: signal ?? undefined,
            });
        });
    });
}

function isFile(path: string): Promise<boolean> {
    return fs.promises.stat(path).then(stats => stats.isFile()).catch(_ => false);
}
