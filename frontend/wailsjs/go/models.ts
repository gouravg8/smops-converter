export namespace main {
	
	export class FileInfo {
	    path: string;
	    name: string;
	    extension: string;
	    kind: string;
	    sizeBytes: number;
	    sizeLabel: string;
	
	    static createFrom(source: any = {}) {
	        return new FileInfo(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	        this.extension = source["extension"];
	        this.kind = source["kind"];
	        this.sizeBytes = source["sizeBytes"];
	        this.sizeLabel = source["sizeLabel"];
	    }
	}
	export class ProcessRequest {
	    inputPath: string;
	    outputDir: string;
	    outputName: string;
	    format: string;
	    maxSizeMB: number;
	    mode: string;
	
	    static createFrom(source: any = {}) {
	        return new ProcessRequest(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.inputPath = source["inputPath"];
	        this.outputDir = source["outputDir"];
	        this.outputName = source["outputName"];
	        this.format = source["format"];
	        this.maxSizeMB = source["maxSizeMB"];
	        this.mode = source["mode"];
	    }
	}
	export class ProcessResult {
	    outputPath: string;
	    outputName: string;
	    sizeBytes: number;
	    sizeLabel: string;
	    message: string;
	
	    static createFrom(source: any = {}) {
	        return new ProcessResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.outputPath = source["outputPath"];
	        this.outputName = source["outputName"];
	        this.sizeBytes = source["sizeBytes"];
	        this.sizeLabel = source["sizeLabel"];
	        this.message = source["message"];
	    }
	}

}

