import * as core from '@actions/core';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

async function run(): Promise<void> {
    try {
        const vaptUrl = core.getInput('vapt-server-url', { required: true });
        const apiKey = core.getInput('api-key', { required: true });
        const target = core.getInput('target', { required: true });
        const repoName = core.getInput('repo-name') || 'unknown';
        const branch = core.getInput('branch') || 'unknown';
        const buildId = core.getInput('build-id') || '000';
        const token = core.getInput('github-token') || '';

        core.info(`[*] Triggering VAPT scan for target: ${target}`);
        
        const headers = { 'X-API-Key': apiKey };
        let jobId = '';

        try {
            const startRes = await axios.post(`${vaptUrl}/api/ci/code-scan/start`, {
                source: target,
                scan_types: ["deps", "sast", "secrets"],
                github_token: token,
                repo_name: repoName,
                branch: branch,
                pipeline_run_id: buildId
            }, { headers, timeout: 30000 });

            jobId = startRes.data.job_id;
            core.info(`[+] Scan started successfully. Job ID: ${jobId}`);
        } catch (error: any) {
            core.setFailed(`[-] Failed to start scan: ${error.response?.data?.error || error.message}`);
            return;
        }

        core.info("[*] Waiting for scan to complete...");
        while (true) {
            await new Promise(resolve => setTimeout(resolve, 10000));
            try {
                const statusRes = await axios.get(`${vaptUrl}/api/ci/code-scan/status/${jobId}`, { headers, timeout: 30000 });
                const status = statusRes.data.status;
                core.info(`   ... status: ${status}`);

                if (status === "completed") {
                    core.info("[+] Scan completed!");
                    break;
                } else if (status === "error") {
                    core.setFailed("[-] Scan failed on the server.");
                    return;
                }
            } catch (error: any) {
                core.info(`[-] Error checking status: ${error.message}`);
            }
        }

        core.info("[*] Fetching scan results...");
        const resultRes = await axios.get(`${vaptUrl}/api/ci/code-scan/result/${jobId}`, { headers, timeout: 30000 });
        const results = resultRes.data;

        const summary = results.summary || {};
        const critical = summary.critical || 0;
        const high = summary.high || 0;

        core.info("\n=== SCAN SUMMARY ===");
        core.info(`Critical: ${critical}`);
        core.info(`High:     ${high}`);
        core.info(`Medium:   ${summary.medium || 0}`);
        core.info(`Low:      ${summary.low || 0}`);
        core.info(`Info:     ${summary.info || 0}`);
        core.info("====================\n");

        // Download Reports
        const reportsDir = path.join(process.env.GITHUB_WORKSPACE || __dirname, 'vapt_reports');
        if (!fs.existsSync(reportsDir)) {
            fs.mkdirSync(reportsDir, { recursive: true });
        }
        const baseFilename = `vapt_report_${repoName}_${branch}_${buildId}`.replace(/[\/\\]/g, '_');
        const htmlPath = path.join(reportsDir, `${baseFilename}.html`);
        const excelPath = path.join(reportsDir, `${baseFilename}.xlsx`);
        
        try {
            core.info("[*] Downloading HTML report...");
            const htmlRes = await axios.get(`${vaptUrl}/api/ci/code-scan/report/${jobId}/html`, {
                headers,
                params: { repo_name: repoName, branch: branch, build_id: buildId },
                responseType: 'arraybuffer',
                timeout: 30000
            });
            let htmlContent = htmlRes.data.toString('utf-8');
            const jsSnippet = `
    <script>
        document.addEventListener("DOMContentLoaded", function() {
            var tabs = document.querySelectorAll('.nav-link');
            tabs.forEach(function(tab) {
                tab.addEventListener('click', function(e) {
                    e.preventDefault();
                    tabs.forEach(function(t) { t.classList.remove('active'); });
                    this.classList.add('active');
                    var panes = document.querySelectorAll('.tab-pane');
                    panes.forEach(function(p) { p.classList.remove('show', 'active'); });
                    var targetId = this.getAttribute('href').substring(1);
                    var targetPane = document.getElementById(targetId);
                    if (targetPane) {
                        targetPane.classList.add('show', 'active');
                    }
                });
            });
        });
    </script>
    </body>
    `;
            htmlContent = htmlContent.replace("</body>", jsSnippet);
            fs.writeFileSync(htmlPath, Buffer.from(htmlContent, 'utf-8'));
            core.info(`[+] HTML report saved to ${htmlPath}`);

            core.info("[*] Downloading Excel report...");
            const excelRes = await axios.get(`${vaptUrl}/api/ci/code-scan/report/${jobId}/excel`, {
                headers,
                params: { repo_name: repoName, branch: branch, build_id: buildId },
                responseType: 'arraybuffer',
                timeout: 30000
            });
            fs.writeFileSync(excelPath, excelRes.data);
            core.info(`[+] Excel report saved to ${excelPath}`);
        } catch (downloadErr: any) {
            core.info(`[-] Warning: Could not download reports: ${downloadErr.message}`);
        }

        if (critical > 0 || high > 0) {
            core.setFailed('[!] Build Failed: Critical or High vulnerabilities found!');
        } else {
            core.info('[+] Build Passed: No critical/high vulnerabilities.');
        }

    } catch (err: any) {
        core.setFailed(err.message);
    }
}

run();
