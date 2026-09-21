import { ensureKernelPython, type KernelPythonSkill } from "../../src/core/kernel/bootstrap.js";

// Runs one ensureKernelPython pass as its own process so a test can SIGKILL it
// mid-sync and prove that the next pass resumes instead of rebuilding.
const skillsArg = process.env.KERNEL_SYNC_CHILD_SKILLS;
if (!skillsArg) {
	throw new Error("KERNEL_SYNC_CHILD_SKILLS is required");
}
const pythonSkills: readonly KernelPythonSkill[] = JSON.parse(skillsArg);
const python = await ensureKernelPython({ pythonSkills });
console.log(`KERNEL-SYNC-CHILD-DONE ${python}`);
