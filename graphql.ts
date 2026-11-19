import type { ForgeStore, Repo, Pull } from './store.ts';

type Token = string | number;
type Value = unknown;
interface Field { name: string; alias: string; args: Record<string, Value>; selections: Field[]; typeCondition?: string; directives?: {name:string;args:Record<string,Value>}[] }
interface Operation { kind: string; name?: string; vars: Record<string, { type: string; defaultValue?: Value }>; fields: Field[] }

class Parser {
  private i = 0;
  private readonly t: Token[];
  constructor(source: string) {
    this.t = [];
    const re = /\s+|#[^\n\r]*|\.\.\.|[_A-Za-z][_0-9A-Za-z]*|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|"(?:\\.|[^"\\])*"|[!$():=@\[\]{|&,]|./gy;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source))) {
      const s = match[0];
      if (/^\s/u.test(s) || s.startsWith('#') || s === ',') continue;
      if (s.startsWith('"')) this.t.push(`\u0000${JSON.parse(s) as string}`);
      else if (/^-?\d/u.test(s)) this.t.push(Number(s));
      else this.t.push(s);
    }
  }
  private peek(): Token | undefined { return this.t[this.i]; }
  private take(): Token { const t = this.t[this.i++]; if (t === undefined) throw Error('Unexpected end of GraphQL document'); return t; }
  private expect(s: string): void { if (this.take() !== s) throw Error(`Expected ${s}`); }
  private name(): string { const v = this.take(); if (typeof v !== 'string' || !/^[_A-Za-z]/u.test(v)) throw Error('Expected a name'); return v; }
  private value(): Value {
    const t = this.take();
    if (typeof t === 'string' && t.startsWith('\u0000')) return t.slice(1);
    if (t === '$') return { $var: this.name() };
    if (t === '[') { const a: Value[] = []; while (this.peek() !== ']') a.push(this.value()); this.take(); return a; }
    if (t === '{') { const o: Record<string, Value> = {}; while (this.peek() !== '}') { const k=this.name(); this.expect(':'); o[k]=this.value(); } this.take(); return o; }
    if (t === 'null') return null; if (t === 'true') return true; if (t === 'false') return false;
    if (t === '...') throw Error('Unexpected spread in value');
    return t;
  }
  private args(): Record<string, Value> { const a: Record<string, Value>={}; if(this.peek()!=='(') return a; this.take(); while(this.peek()!==')'){ const k=this.name(); this.expect(':'); a[k]=this.value(); } this.take(); return a; }
  private selections(typeCondition?: string): Field[] {
    this.expect('{'); const fields: Field[]=[];
    while(this.peek()!=='}') {
      if(this.peek()==='...') { this.take(); if(this.peek()==='on'){this.take(); const condition=this.name(); const selections=this.selections(); fields.push({name:'...',alias:'...',args:{},selections,typeCondition:condition});} else { const fragment=this.name(); fields.push({name:'...'+fragment,alias:'...',args:{},selections:[]}); } continue; }
      const first=this.name(); let alias=first,name=first; if(this.peek()===':'){this.take(); alias=first; name=this.name();}
      const args=this.args(); const directives:{name:string;args:Record<string,Value>}[]=[]; while(this.peek()==='@'){this.take();directives.push({name:this.name(),args:this.args()});}
      fields.push({name,alias,args,selections:this.peek()==='{'?this.selections():[],directives});
    }
    this.take(); return typeCondition ? [{name:'...',alias:'...',args:{},selections:fields,typeCondition}] : fields;
  }
  parse(): { ops: Operation[]; fragments: Map<string, Field[]> } {
    const ops: Operation[]=[]; const fragments=new Map<string,Field[]>();
    while(this.peek()!==undefined) {
      if(this.peek()==='fragment'){this.take();const name=this.name();this.expect('on');const type=this.name();fragments.set(name,this.selections(type));continue;}
      let kind='query',name: string|undefined;
      if(this.peek()==='{'){ops.push({kind,name,vars:{},fields:this.selections()});continue;}
      kind=this.name(); if(kind!=='query'&&kind!=='mutation'&&kind!=='subscription') throw Error('Expected operation');
      if(typeof this.peek()==='string'&&/^[_A-Za-z]/u.test(String(this.peek()))&&this.peek()!=='(') name=this.name();
      const vars: Operation['vars']={};
      if(this.peek()==='('){this.take();while(this.peek()!==')'){this.expect('$');const n=this.name();this.expect(':');let ty='';while(this.peek()!==undefined&&this.peek()!=='='&&this.peek()!==')'&&this.peek()!=='$'){ty+=String(this.take());} let defaultValue:Value|undefined;if(this.peek()==='='){this.take();defaultValue=this.value();} vars[n]={type:ty,defaultValue};}this.take();}
      while(this.peek()==='@'){this.take();this.name();this.args();}
      ops.push({kind,name,vars,fields:this.selections()});
    }
    return {ops,fragments};
  }
}
const enums: Record<string,string[]>={IssueState:['OPEN','CLOSED'],MergeableState:['MERGEABLE','CONFLICTING','UNKNOWN'],PullRequestState:['OPEN','CLOSED','MERGED'],PullRequestMergeMethod:['MERGE','SQUASH','REBASE'],RepositoryPermission:['ADMIN','MAINTAIN','WRITE','TRIAGE','READ'],SearchType:['ISSUE','REPOSITORY','USER','DISCUSSION','WIKI'],IssueOrderField:['CREATED_AT','UPDATED_AT','COMMENTS'],OrderDirection:['ASC','DESC']};
const typeFields: Record<string,string[]>={Issue:['id','databaseId','number','title','body','state','labels','createdAt','updatedAt','comments','url','html_url'],PullRequest:['id','databaseId','number','title','body','state','merged','mergeable','headRefName','baseRefName','headRefOid','baseRefOid','files'],Repository:['id','databaseId','name','nameWithOwner','owner','defaultBranchRef','viewerPermission','hasIssuesEnabled','description','isPrivate','issue','issues','pullRequests','pullRequest'],User:['login','id','databaseId'],IssueConnection:['nodes','pageInfo'],PullRequestConnection:['nodes'],PageInfo:['hasNextPage','endCursor'],PullRequestChangedFile:['path'],Ref:['name'],Comment:['id','body']};
const schemaFields:Record<string,string[]>={Query:['viewer','repository','node','__type','__typename'],Mutation:['createIssue','closeIssue','createPullRequest','mergePullRequest','addComment','__typename'],Issue:['id','databaseId','number','title','body','state','labels','createdAt','updatedAt','comments','url','html_url','__typename'],PullRequest:['id','databaseId','number','title','body','state','merged','mergeable','headRefName','baseRefName','headRefOid','baseRefOid','files','__typename'],Repository:typeFields.Repository,User:typeFields.User,IssueConnection:typeFields.IssueConnection,PullRequestConnection:typeFields.PullRequestConnection,PageInfo:typeFields.PageInfo,PullRequestChangedFile:typeFields.PullRequestChangedFile,PullRequestChangedFileConnection:['nodes','__typename'],Ref:typeFields.Ref,'__Type':['name','kind','fields','enumValues','__typename'],'__Field':['name','description','type','args','isDeprecated','deprecationReason','__typename'],'__EnumValue':['name','description','isDeprecated','deprecationReason','__typename']};
const resultTypes:Record<string,string>={createIssue:'CreateIssuePayload',closeIssue:'CloseIssuePayload',createPullRequest:'CreatePullRequestPayload',mergePullRequest:'MergePullRequestPayload',addComment:'AddCommentPayload',issue:'Issue',pullRequest:'PullRequest',issues:'IssueConnection',pullRequests:'PullRequestConnection',owner:'User',defaultBranchRef:'Ref',files:'PullRequestChangedFileConnection',nodes:'Node',pageInfo:'PageInfo',fields:'__Field',enumValues:'__EnumValue',commentEdge:'CommentEdge',node:'Node',repository:'Repository',viewer:'User'};
schemaFields.CreateIssuePayload=['issue'];schemaFields.CloseIssuePayload=['issue'];schemaFields.CreatePullRequestPayload=['pullRequest'];schemaFields.MergePullRequestPayload=['pullRequest'];schemaFields.AddCommentPayload=['commentEdge'];schemaFields.CommentEdge=['node'];schemaFields.Comment=['id','body','__typename'];
const typeFor: Record<string,string>={viewer:'User',repository:'Repository',node:'Node',__type:'__Type',id:'ID',databaseId:'Int',number:'Int',title:'String',body:'String',state:'String',merged:'Boolean',mergeable:'MergeableState',headRefName:'String',baseRefName:'String',files:'PullRequestChangedFileConnection',nodes:'[Node]',pageInfo:'PageInfo',hasNextPage:'Boolean',endCursor:'String',path:'String',login:'String',name:'String',nameWithOwner:'String',defaultBranchRef:'Ref',viewerPermission:'RepositoryPermission',hasIssuesEnabled:'Boolean',issue:'Issue',issues:'IssueConnection',pullRequests:'PullRequestConnection',pullRequest:'PullRequest',fields:'[__Field]',enumValues:'[__EnumValue]'};
function resolve(v:Value, vars:Record<string,unknown>):unknown { if(v&&typeof v==='object'&&!Array.isArray(v)&&'$var' in v)return vars[String((v as {$var:string}).$var)]; if(Array.isArray(v))return v.map(x=>resolve(x,vars)); if(v&&typeof v==='object'){const o:Record<string,unknown>={};for(const[k,x]of Object.entries(v))o[k]=resolve(x as Value,vars);return o;}return v; }
function relay(kind:string,id:string|number):string { return `${kind}:${id}`; }
function unpack(id:unknown):{kind:string,id:string}|undefined { if(typeof id!=='string')return;const i=id.indexOf(':');return i<0?undefined:{kind:id.slice(0,i),id:id.slice(i+1)}; }

export function executeGraphQL(body: unknown, store: ForgeStore): unknown {
  if(Array.isArray(body)) return body.map(item=>executeGraphQL(item,store));
  if(!body||typeof body!=='object') return {data:null,errors:[{message:'Request body must be an object'}]};
  const req=body as Record<string,unknown>; if(typeof req.query!=='string')return {data:null,errors:[{message:'query must be a string'}]};
  try {
    const {ops,fragments}=new Parser(req.query).parse(); const chosen=ops.filter(o=>o.kind==='query'||o.kind==='mutation');
    let op:Operation|undefined;
    if(typeof req.operationName==='string')op=chosen.find(o=>o.name===req.operationName); else if(chosen.length===1)op=chosen[0];
    if(!op)throw Error(chosen.length?'operationName is required when a document has multiple operations':'No operation found');
    if(op.kind==='subscription')throw Error('Subscriptions are not supported');
    const vars:Record<string,unknown>={...(req.variables&&typeof req.variables==='object'?req.variables as Record<string,unknown>:{})};
    for(const [k,v] of Object.entries(op.vars)){if(vars[k]===undefined&&v.defaultValue!==undefined)vars[k]=resolve(v.defaultValue,vars);if(v.type.endsWith('!')&&(vars[k]===undefined||vars[k]===null))throw Error(`Variable "$${k}" of required type "${v.type}" was not provided`);}
    const errors:string[]=[];
    const expanded=(fs:Field[], seen=new Set<string>()):Field[]=>fs.flatMap(f=>{if(f.name.startsWith('...')){if(f.typeCondition)return [{...f,selections:expanded(f.selections,seen)}];const n=f.name.slice(3);if(seen.has(n)||!fragments.has(n))return [];const next=new Set(seen);next.add(n);return expanded(fragments.get(n)!,next);}return [f];});
    const validate=(fs:Field[], parentType:string, seen=new Set<string>()):void=>{for(const f of expanded(fs,seen)){if(f.typeCondition){validate(f.selections,f.typeCondition,seen);continue;}const allowed=schemaFields[parentType];if(allowed&&!allowed.includes(f.name)){errors.push(`Cannot query field "${f.name}" on type "${parentType}".`);continue;}let child=resultTypes[f.name]??typeFor[f.name];if(f.name==='__type')child='__Type';if(f.name==='node')child='Node';if(f.name==='nodes')child=parentType==='PullRequestChangedFileConnection'?'PullRequestChangedFile':'Node';if(f.selections.length&&child)validate(f.selections,child,seen);}};
    validate(op.fields,op.kind==='mutation'?'Mutation':'Query');
    if(errors.length)return {data:null,errors:errors.map(message=>({message}))};
    const project=(value:any, fields:Field[], type:string):any=>{
      if(value===null||value===undefined)return null;
      const out:Record<string,unknown>={};
      for(const f of expanded(fields)){
        const directives=f.directives??[]; const skip=directives.find(d=>d.name==='skip'); const include=directives.find(d=>d.name==='include');
        if(skip&&resolve(skip.args.if,vars)===true)continue;
        if(include&&resolve(include.args.if,vars)!==true)continue;
        if(f.typeCondition){if(f.typeCondition===type)Object.assign(out,project(value,f.selections,type));continue;}
        if(f.name==='__typename'){out[f.alias]=type;continue;}
        const a=Object.fromEntries(Object.entries(f.args).map(([k,v])=>[k,resolve(v,vars)]));
        const result=field(value,f.name,a,op!.kind,errors);
        if(result===undefined)continue;
        out[f.alias]=Array.isArray(result)?result.map(x=>project(x,f.selections,f.name==='nodes'?inferType(x):(typeFor[f.name]??inferType(x)))): f.selections.length?project(result,f.selections,typeFor[f.name] && typeFor[f.name] !== 'Node' ? typeFor[f.name] : inferType(result)):result;
      } return out;
    };
    const inferType=(v:any):string=>v?.__type??(v?.full_name?'Repository':v?.head?'PullRequest':v?.number!==undefined?'Issue':'Node');
    const field=(parent:any,name:string,args:Record<string,any>,kind:string,errs:string[]):any=>{
      if(name==='__type')return introspect(args.name);
      if(parent==='root'){
        if(name==='viewer')return store.viewer;
        if(name==='repository')return store.findRepo(String(args.owner??''),String(args.name??'')) ?? null;
        if(name==='node'){
          const raw=String(args.id??''); const decoded=unpack(raw);
          return findRepoGlobal(raw,decoded) ?? findIssueGlobal(raw,decoded) ?? findPullGlobal(raw,decoded);
        }
        if(kind==='mutation')return mutation(name,args,errs);
        errs.push(`Cannot query field "${name}" on type "Query".`);return undefined;
      }
      if(name==='id')return parent.node_id ?? relay(inferType(parent),parent.id);
      if(name==='databaseId')return parent.id;
      if(name==='nameWithOwner')return parent.full_name;
      if(name==='isPrivate')return parent.private;
      if(name==='hasIssuesEnabled')return parent.has_issues;
      if(name==='owner')return parent.owner;
      if(name==='defaultBranchRef')return {name:parent.default_branch};
      if(name==='viewerPermission')return 'ADMIN';
      if(name==='issue' && parent.issues instanceof Map)return parent.issues?.get(Number(args.number)) ?? null;
      if(name==='pullRequest' && parent.pulls instanceof Map)return parent.pulls?.get(Number(args.number)) ?? null;
        if(name==='issues'||name==='pullRequests'){
        const items=[...(name==='issues'?parent.issues?.values?.()??[]:parent.pulls?.values?.()??[])];
        let filtered=items;
        if(Array.isArray(args.states))filtered=filtered.filter((x:any)=>args.states.includes(name==='pullRequests' && x.merged ? 'MERGED' : String(x.state).toUpperCase()));
        if(name==='issues'&&args.orderBy?.direction==='DESC')filtered=[...filtered].reverse();
        const start=args.after?Number(String(args.after).replace(/^cursor:/u,'')):0;const first=args.first==null?filtered.length:Number(args.first);const page=filtered.slice(start,start+first);
        return {nodes:page,pageInfo:{hasNextPage:start+first<filtered.length,endCursor:page.length?`cursor:${start+page.length}`:null}};
      }
      if(name==='files'){
        for(const repo of allRepos()) for(const pull of repo.pulls.values()) if(pull===parent || pull.node_id===parent.node_id) {
          const files=store.pullFiles(repo,pull);
          return {nodes:(args.first==null?files:files.slice(0,Math.max(0,Number(args.first)))).map((file:any)=>({path:file.filename}))};
        }
        return {nodes:[]};
      }
      if(name==='headRefName')return parent.head?.ref??parent.headRefName;
      if(name==='baseRefName')return parent.base?.ref??parent.baseRefName;
      if(name==='headRefOid')return parent.head?.sha;
      if(name==='baseRefOid')return parent.base?.sha;
      if(name==='merged')return parent.merged??false;
      if(name==='mergeable')return parent.mergeable===true?'MERGEABLE':parent.mergeable===false?'CONFLICTING':'UNKNOWN';
      if(name==='state')return parent.merged?'MERGED':String(parent.state??'open').toUpperCase();
      if(name==='createdAt')return parent.created_at;
      if(name==='updatedAt')return parent.updated_at;
      if(name==='labels')return parent.labels??[];
      if(name==='__typename')return inferType(parent);
      if(name in parent)return parent[name];
      errs.push(`Cannot query field "${name}" on type "${inferType(parent)}".`);return undefined;
    };
    function allRepos():Repo[]{const s=store as any;return [...(s.repos?.values?.()??[])];}
    function findRepoGlobal(raw:string, decoded:{kind:string,id:string}|undefined):Repo|undefined { return store.repoById(raw) ?? (decoded?.kind==='Repository'?store.repoById(decoded.id):undefined) ?? allRepos().find(r=>r.node_id===raw || String(r.id)===raw); }
    function findIssueGlobal(raw:string, decoded:{kind:string,id:string}|undefined):unknown { for(const r of allRepos()) for(const i of r.issues.values()) if(i.node_id===raw || String(i.id)===raw || (decoded?.kind==='Issue' && String(i.id)===decoded.id)) return i; return null; }
    function findPullAndRepo(raw:string, decoded:{kind:string,id:string}|undefined):{repo:Repo;pull:Pull}|undefined { for(const repo of allRepos()) for(const pull of repo.pulls.values()) if(pull.node_id===raw || String(pull.id)===raw || (decoded?.kind==='PullRequest' && String(pull.id)===decoded.id) || (decoded?.kind==='Pull' && String(pull.id)===decoded.id)) return {repo,pull}; return undefined; }
    function findPullGlobal(raw:string, decoded:{kind:string,id:string}|undefined):unknown {return findPullAndRepo(raw,decoded)?.pull ?? null;}
    function findIssueAndRepo(raw:string, decoded:{kind:string,id:string}|undefined):{repo:Repo;issue:any}|undefined { for(const repo of allRepos()) for(const issue of repo.issues.values()) if(issue.node_id===raw || String(issue.id)===raw || (decoded?.kind==='Issue' && String(issue.id)===decoded.id)) return {repo,issue}; return undefined; }
    function introspect(name:unknown):unknown {if(typeof name!=='string')return null; if(enums[name])return {__type:'__Type',name,kind:'ENUM',enumValues:enums[name].map(n=>({name:n}))}; if(typeFields[name])return {__type:'__Type',name,kind:'OBJECT',fields:typeFields[name].map(n=>({name:n}))}; return null;}
    function mutation(name:string,args:Record<string,any>,errs:string[]):unknown {
      const input=args.input??{};
      if(name==='createIssue'||name==='closeIssue'){
        const raw=String(input.repositoryId??input.issueId??''); const id=unpack(raw);
        if(name==='createIssue'){
          const repo=findRepoGlobal(raw,id);if(!repo)throw Error('Repository not found');
          const issue=store.createIssue(repo,{title:input.title,body:input.body});return {issue};
        }
        const found=findIssueAndRepo(raw,id);if(!found)throw Error('Issue not found');
        store.updateIssue(found.repo,found.issue,{state:'closed'});return {issue:found.issue};
      }
      if(name==='createPullRequest'){
        const raw=String(input.repositoryId??''); const p=unpack(raw);const repo=findRepoGlobal(raw,p);if(!repo)throw Error('Repository not found');
        const pull=store.createPull(repo,{title:String(input.title??''),head:String(input.headRefName??''),base:String(input.baseRefName??''),body:input.body});return {pullRequest:pull};
      }
      if(name==='mergePullRequest'){const raw=String(input.pullRequestId??'');const found=findPullAndRepo(raw,unpack(raw));if(!found)throw Error('Pull request not found');store.mergePull(found.repo,found.pull.number);return {pullRequest:found.pull};}
      if(name==='addComment'){
        const raw=String(input.subjectId??''); const p=unpack(raw);const found=findIssueAndRepo(raw,p);if(!found)throw Error('Comment subject not found');const comment=store.createComment(found.repo,found.issue,String(input.body??''));return {commentEdge:{node:comment}};
      }
      errs.push(`Cannot query field "${name}" on type "Mutation".`);return undefined;
    }
    const data=project('root',op.fields,op.kind==='mutation'?'Mutation':'Query');return errors.length?{data,errors:errors.map(message=>({message}))}:{data};
  } catch(e){return {data:null,errors:[{message:e instanceof Error?e.message:String(e)}]};}
}
