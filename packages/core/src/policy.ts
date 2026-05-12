export type PolicyDecision = {
  action: "allow" | "confirm" | "deny";
  reason: string;
  risk: "low" | "medium" | "high";
};

export type PolicyRule = {
  id: string;
  label: string;
  action: PolicyDecision["action"];
  risk: PolicyDecision["risk"];
  patterns: RegExp[];
};

export const defaultShellRules: PolicyRule[] = [
  {
    id: "deny-piped-install",
    label: "远程脚本管道安装",
    action: "deny",
    risk: "high",
    patterns: [/curl\s+.+\|\s*(sh|bash|pwsh|powershell)/i, /Invoke-WebRequest.+\|\s*Invoke-Expression/i]
  },
  {
    id: "deny-host-destruction",
    label: "破坏性宿主命令",
    action: "deny",
    risk: "high",
    patterns: [
      /rm\s+-rf\s+(\/|\*)/i,
      /Remove-Item\s+.+-Recurse.+-Force/i,
      /git\s+clean\s+-fdx/i,
      /docker\s+system\s+prune/i
    ]
  },
  {
    id: "confirm-dependencies",
    label: "依赖安装命令",
    action: "confirm",
    risk: "medium",
    patterns: [/\b(npm|pnpm|yarn|bun)\s+(install|add)\b/i, /\b(pip|uv)\s+install\b/i]
  },
  {
    id: "confirm-git-write",
    label: "Git 写操作",
    action: "confirm",
    risk: "medium",
    patterns: [/\bgit\s+(commit|push|reset|rebase|merge|checkout|switch)\b/i]
  },
  {
    id: "confirm-network",
    label: "网络访问命令",
    action: "confirm",
    risk: "medium",
    patterns: [/\b(curl|wget|Invoke-WebRequest|iwr)\b/i]
  }
];

export function classifyShellCommand(command: string, rules = defaultShellRules): PolicyDecision {
  for (const rule of rules) {
    if (rule.patterns.some((pattern) => pattern.test(command))) {
      return {
        action: rule.action,
        risk: rule.risk,
        reason: rule.label
      };
    }
  }

  return {
    action: "allow",
    risk: "low",
    reason: "命令未命中高风险策略规则。"
  };
}

export const defaultToolSpecs = [
  {
    name: "read_file",
    description: "读取当前工作区内的文件。",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: { type: "string" }
      }
    },
    permissions: { filesystem: "read" as const }
  },
  {
    name: "search_workspace",
    description: "搜索当前工作区内的文件。",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        glob: { type: "string" }
      }
    },
    permissions: { filesystem: "read" as const }
  },
  {
    name: "propose_patch",
    description: "生成可审查 patch，但不直接应用。",
    inputSchema: {
      type: "object",
      required: ["path", "patch"],
      properties: {
        path: { type: "string" },
        patch: { type: "string" }
      }
    },
    permissions: { filesystem: "write" as const }
  },
  {
    name: "run_shell",
    description: "在隔离的工作区运行时中执行命令。",
    inputSchema: {
      type: "object",
      required: ["command"],
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: { type: "number" }
      }
    },
    permissions: { shell: true, filesystem: "read" as const, network: false }
  }
];
