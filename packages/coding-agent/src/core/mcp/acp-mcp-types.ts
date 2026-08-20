export type AcpMcpServerConfig =
	| {
			name: string;
			type: "http";
			url: string;
			headers: Record<string, string>;
	  }
	| {
			name: string;
			type: "stdio";
			command: string;
			args: string[];
			cwd: string;
			env: Record<string, string>;
	  };
