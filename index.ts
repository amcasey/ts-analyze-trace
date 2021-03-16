if (process.argv.length !== 3) {
    const path = require("path");
    console.error(`Usage: ${path.basename(process.argv[0])} ${path.basename(process.argv[1])} trace_dir`);
    process.exit(1);
}

import cp = require("child_process");
import fs = require("fs");
import os = require("os");
import path = require("path");

import plimit = require("p-limit");
const limit = plimit(os.cpus().length);

const traceDir = process.argv[2];

if (!fs.statSync(traceDir)?.isDirectory()) {
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
    stdout: string;
    stderr: string;
    exitCode: number | undefined;
    signal: NodeJS.Signals | undefined;
}

async function main(): Promise<boolean> {
    let projects: undefined | Project[];

    const legendPath = path.join(traceDir, "legend.json");
    if (await fs.promises.stat(legendPath).then(stats => stats.isFile()).catch(_ => false)) {
        try {
            const legendText = await fs.promises.readFile(legendPath, { encoding: "utf-8" });
            projects = JSON.parse(legendText);
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

    const projectCount = projects.length;

    hadHotSpots.sort((a, b) => b.score - a.score); // Descending
    for (const result of hadHotSpots) {
        const project = result.project;
        if (projectCount > 1 || project.configFilePath) {
            console.log(`Analyzed ${project.configFilePath ?? path.basename(project.tracePath)}`);
        }
        console.log(result.stdout);
    }

    for (const errorResult of hadErrors) {
        const project = errorResult.project;
        console.log(`Error analyzing ${project.configFilePath ?? path.basename(project.tracePath)}`);
        if (errorResult.stderr) {
            console.log(`Error: ${errorResult.stderr}`);
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
        console.log(`Found nothing in ${projectCount - interestingCount}${interestingCount ? " other" : ""} project(s)`);
    }

    return hadErrors.length > 0;
}

async function analyzeProject(project: Project): Promise<ProjectResult> {
    return new Promise<ProjectResult>(resolve => {
        const child = cp.fork("./analyze-trace", [project.tracePath, project.typesPath], { stdio: "pipe", env: { FORCE_COLOR: '1' } });

        let stdout = "";
        let stderr = "";

        child.stdout!.on("data", chunk => stdout += chunk);
        child.stderr!.on("data", chunk => stderr += chunk);

        child.on("exit", (code, signal) => {
            resolve({
                project,
                stdout,
                stderr,
                exitCode: code ?? undefined,
                signal: signal ?? undefined,
            });
        });
    });
}