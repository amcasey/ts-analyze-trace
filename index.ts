if (process.argv.length !== 3) {
    const path = require("path");
    console.error(`Usage: ${path.basename(process.argv[0])} ${path.basename(process.argv[1])} trace_dir`);
    process.exit(1);
}

import fs = require("fs");
import path = require("path");
import cp = require("child_process");

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

    return await analyzeTraces(projects);
}

async function analyzeTraces(projects: readonly Project[]): Promise<boolean> {
    let sawError = false;
    // TODO (acasey): sort output
    for (const project of projects) { // TODO (acasey): parallel
        console.log(`Analyzing ${project.configFilePath ?? path.basename(project.tracePath)}`);
        try {
            console.log(await analyzeTrace(project.tracePath, project.typesPath));
        }
        catch (e) {
            sawError = true;
            console.log(`Error: ${e.message}`);
        }
    }
    return !sawError;
}

async function analyzeTrace(tracePath: string, typesPath: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const child = cp.fork("./analyze-trace", [tracePath, typesPath], { stdio: "pipe", env: { FORCE_COLOR: '1' } });

        let output = "";
        let errors = "";

        child.stdout!.on("data", chunk => output += chunk);
        child.stderr!.on("data", chunk => errors += chunk);

        child.on("exit", (code, signal) => {
            if (errors) {
                reject(new Error(errors));
            }
            else if (code) {
                reject(new Error(`Exited with code ${code}`));
            }
            else if (signal) {
                reject(new Error(`Terminated with signal ${signal}`));
            }
            else {
                resolve(output);
            }
        });
    });
}