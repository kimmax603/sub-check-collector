import axios, { AxiosError } from 'axios';
import { Octokit } from '@octokit/rest';
import { SubscriptionLink } from './types';
import { getProxyAgents } from './proxy-agent';

interface ValidationResult {
  link: SubscriptionLink;
  isValid: boolean;
  isExpired: boolean;
  error?: string;
}

export class LinkValidator {
  private timeout: number;
  private concurrency: number;
  private proxyUrl?: string;
  private maxDaysSinceSubUpdate?: number;
  private proxyAgents: ReturnType<typeof getProxyAgents>;
  private octokit?: Octokit;

  constructor(timeout: number = 10000, concurrency: number = 10, proxyUrl?: string, maxDaysSinceSubUpdate?: number, githubToken?: string) {
    this.timeout = timeout;
    this.concurrency = concurrency;
    this.proxyUrl = proxyUrl;
    this.maxDaysSinceSubUpdate = maxDaysSinceSubUpdate;
    this.proxyAgents = getProxyAgents(proxyUrl);
    if (githubToken) {
      this.octokit = new Octokit({ auth: githubToken });
    }
  }

  private isDateExpired(lastModified: string, maxDays: number): boolean {
    try {
      const fileDate = new Date(lastModified);
      if (isNaN(fileDate.getTime())) return false;
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - maxDays);
      return fileDate < cutoffDate;
    } catch {
      return false;
    }
  }

  /**
   * 通过 GitHub API 检查文件最后提交时间
   * 仅支持 raw.githubusercontent.com 链接
   */
  private async getFileLastCommitDate(url: string): Promise<Date | null> {
    if (!this.octokit) return null;

    try {
      const parsed = this.parseGitHubUrl(url);
      if (!parsed) return null;

      const commits = await this.octokit.rest.repos.listCommits({
        owner: parsed.owner,
        repo: parsed.repo,
        path: parsed.filePath,
        sha: parsed.branch,
        per_page: 1,
      });

      if (commits.data.length > 0 && commits.data[0].commit.committer?.date) {
        return new Date(commits.data[0].commit.committer.date);
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 通过 GitHub API 验证文件是否存在
   * 返回 true 表示文件存在，false 表示不存在
   */
  private async checkFileExistsViaApi(url: string): Promise<boolean> {
    if (!this.octokit) return true;

    try {
      const parsed = this.parseGitHubUrl(url);
      if (!parsed) return true;

      await this.octokit.rest.repos.getContent({
        owner: parsed.owner,
        repo: parsed.repo,
        path: parsed.filePath,
        ref: parsed.branch,
      });
      return true;
    } catch (err: any) {
      if (err?.status === 404) return false;
      return true;
    }
  }

  /**
   * 通过 GitHub API 同时验证文件存在性和内容有效性，返回节点数
   */
  private async validateViaGitHubApi(url: string): Promise<{ exists: boolean; nodeCount: number }> {
    if (!this.octokit) return { exists: true, nodeCount: 0 };

    try {
      const parsed = this.parseGitHubUrl(url);
      if (!parsed) return { exists: true, nodeCount: 0 };

      const response = await this.octokit.rest.repos.getContent({
        owner: parsed.owner,
        repo: parsed.repo,
        path: parsed.filePath,
        ref: parsed.branch,
      });

      if (Array.isArray(response.data) || response.data.type !== 'file') {
        return { exists: true, nodeCount: 0 };
      }

      const content = Buffer.from(response.data.content, 'base64').toString('utf-8');
      const nodeCount = this.countValidNodes(content);
      return { exists: true, nodeCount };
    } catch (err: any) {
      if (err?.status === 404) return { exists: false, nodeCount: 0 };
      return { exists: true, nodeCount: 0 };
    }
  }

  private parseGitHubUrl(url: string): { owner: string; repo: string; branch: string; filePath: string } | null {
    const match = url.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(.+)/);
    if (!match) return null;

    const [, owner, repo, rest] = match;
    let branch: string;
    let filePath: string;

    if (rest.startsWith('refs/')) {
      const refsPrefix = 'refs/heads/';
      const afterRefs = rest.substring(refsPrefix.length);
      const slashIndex = afterRefs.indexOf('/');
      if (slashIndex === -1) return null;
      branch = refsPrefix + afterRefs.substring(0, slashIndex);
      filePath = afterRefs.substring(slashIndex + 1);
    } else {
      const slashIndex = rest.indexOf('/');
      if (slashIndex === -1) return null;
      branch = rest.substring(0, slashIndex);
      filePath = rest.substring(slashIndex + 1);
    }

    return { owner, repo, branch, filePath };
  }

  /**
   * 解析订阅内容，返回有效节点数量
   * 学习 subs-check-pro 的验证逻辑：真正解析节点并校验字段
   */
  private countValidNodes(content: string): number {
    if (!content || content.trim().length === 0) return 0;

    const text = content.trim();
    let nodes: string[] = [];

    // 1. 尝试 Base64 解码
    const base64Regex = /^[A-Za-z0-9+/=\s]+$/;
    if (base64Regex.test(text)) {
      const cleaned = text.replace(/\s/g, '');
      if (cleaned.length >= 20) {
        try {
          const decoded = Buffer.from(cleaned, 'base64').toString('utf-8');
          if (decoded.includes('://')) {
            nodes = decoded.split('\n').filter(l => l.trim().length > 0);
          }
        } catch {}
      }
    }

    // 2. 如果 Base64 没出结果，按行解析
    if (nodes.length === 0) {
      nodes = text.split('\n').filter(l => l.trim().length > 0);
    }

    // 3. 解析 Clash/Mihomo YAML 格式 (proxies 数组)
    if (nodes.length === 0 || text.includes('proxies:')) {
      try {
        const yamlMatch = text.match(/proxies:\s*\n([\s\S]*?)(?=\n[a-zA-Z]|\z)/);
        if (yamlMatch) {
          const proxyBlock = yamlMatch[1];
          const proxyEntries = proxyBlock.split(/\n(?=- name:)/);
          let yamlCount = 0;
          for (const entry of proxyEntries) {
            const nameMatch = entry.match(/- name:\s*(.+)/);
            const typeMatch = entry.match(/type:\s*(\w+)/);
            const serverMatch = entry.match(/server:\s*(.+)/);
            const portMatch = entry.match(/port:\s*(\d+)/);
            if (nameMatch && typeMatch && serverMatch && portMatch) {
              const port = parseInt(portMatch[1]);
              if (port > 0 && port <= 65535) yamlCount++;
            }
          }
          if (yamlCount > 0) return yamlCount;
        }
      } catch {}
    }

    // 4. 统计有效的协议链接
    const protocolRegex = /^(vmess|vless|trojan|ss|ssr|hysteria|tuic|wg|wireguard):\/\//i;
    let validCount = 0;

    for (const line of nodes) {
      const trimmed = line.trim();
      if (!protocolRegex.test(trimmed)) continue;

      // 提取 server 和 port 进行校验
      try {
        if (trimmed.toLowerCase().startsWith('vmess://')) {
          const decoded = Buffer.from(trimmed.slice(8), 'base64').toString('utf-8');
          const obj = JSON.parse(decoded);
          if (obj.server && obj.port && obj.port > 0 && obj.port <= 65535) validCount++;
        } else {
          // vless://, trojan://, ss:// 等格式：从 URL 中提取 host:port
          const urlPart = trimmed.split('://')[1] || '';
          const atIndex = urlPart.indexOf('@');
          if (atIndex > 0) {
            const hostPort = urlPart.slice(atIndex + 1).split(/[/?#]/)[0];
            const colonIdx = hostPort.lastIndexOf(':');
            if (colonIdx > 0) {
              const port = parseInt(hostPort.slice(colonIdx + 1));
              if (port > 0 && port <= 65535) validCount++;
            }
          }
        }
      } catch {}
    }

    return validCount;
  }

  private isContentValid(content: string): boolean {
    return this.countValidNodes(content) > 0;
  }

  private isValidBase64Subscription(text: string): boolean {
    // base64 订阅通常是纯 base64 字符串（可能有换行）
    const base64Regex = /^[A-Za-z0-9+/=\s]+$/;
    if (!base64Regex.test(text)) return false;

    // 去除空白后尝试解码
    const cleaned = text.replace(/\s/g, '');
    if (cleaned.length < 20) return false;

    try {
      const decoded = Buffer.from(cleaned, 'base64').toString('utf-8');
      // 解码后应包含有效的协议前缀
      return /vmess:\/\//i.test(decoded) ||
        /vless:\/\//i.test(decoded) ||
        /trojan:\/\//i.test(decoded) ||
        /ss:\/\//i.test(decoded) ||
        /ssr:\/\//i.test(decoded);
    } catch {
      return false;
    }
  }

  private async validateSingleLink(link: SubscriptionLink): Promise<ValidationResult> {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    };

    try {
      // 单次 GET 请求：同时获取响应头（Last-Modified）和响应体（内容校验）
      const response = await axios.get(link.url, {
        timeout: this.timeout,
        validateStatus: () => true,
        headers,
        maxRedirects: 5,
        ...this.proxyAgents,
      });

      // HTTP 429 速率限制 - 重试一次
      if (response.status === 429) {
        const retryAfter = response.headers['retry-after'];
        const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
        await new Promise(resolve => setTimeout(resolve, Math.min(waitTime, 30000)));
        const retryResp = await axios.get(link.url, {
          timeout: this.timeout,
          validateStatus: () => true,
          headers,
          maxRedirects: 5,
          ...this.proxyAgents,
        });
        if (retryResp.status >= 200 && retryResp.status < 400) {
          const content = typeof retryResp.data === 'string' ? retryResp.data : '';
          const isValid = this.isContentValid(content);
          return { link, isValid, isExpired: false, error: isValid ? undefined : '内容无效' };
        }
        return { link, isValid: false, isExpired: false, error: `HTTP ${retryResp.status}` };
      }

      // 非 2xx 响应
      if (response.status < 200 || response.status >= 400) {
        return { link, isValid: false, isExpired: false, error: `HTTP ${response.status}` };
      }

      // 对 raw.githubusercontent.com 用 GitHub API 验证文件内容和节点数
      let nodeCount = 0;
      if (link.url.includes('raw.githubusercontent.com') && this.proxyUrl) {
        const apiResult = await this.validateViaGitHubApi(link.url);
        if (!apiResult.exists) {
          return { link, isValid: false, isExpired: false, error: '文件不存在(API 404)' };
        }
        nodeCount = apiResult.nodeCount;
        if (nodeCount === 0) {
          return { link, isValid: false, isExpired: false, error: '无有效节点' };
        }
      }

      // 检查新鲜度
      // 优先级: GitHub API 文件提交时间 > HTTP Last-Modified > 默认不认为过期
      const maxDays = this.maxDaysSinceSubUpdate ?? 30;
      let isExpired = false;

      // 1. 对 raw.githubusercontent.com 链接，用 GitHub API 检查文件最后提交时间
      if (link.url.includes('raw.githubusercontent.com')) {
        const fileCommitDate = await this.getFileLastCommitDate(link.url);
        if (fileCommitDate) {
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - maxDays);
          isExpired = fileCommitDate < cutoffDate;
        }
      }

      // 2. 如果 GitHub API 没有返回结果，用 HTTP Last-Modified 检查
      if (!isExpired) {
        const lastModified = response.headers['last-modified'];
        if (lastModified) {
          isExpired = this.isDateExpired(lastModified, maxDays);
        }
      }

      // 校验内容有效性并统计节点数
      const content = typeof response.data === 'string' ? response.data : '';
      if (nodeCount === 0) {
        nodeCount = this.countValidNodes(content);
      }
      const isValid = nodeCount > 0;

      return {
        link: {
          ...link,
          nodeCount,
        },
        isValid,
        isExpired,
        error: isValid ? undefined : '内容无效',
      };
    } catch (error: any) {
      let errorMsg = '访问失败';

      if (error?.code === 'ECONNABORTED') {
        errorMsg = '超时';
      } else if (error?.response) {
        errorMsg = `HTTP ${error.response.status}`;
      } else if (error?.code === 'ENOTFOUND') {
        errorMsg = '域名无法解析';
      } else if (error?.code === 'ECONNREFUSED') {
        errorMsg = '连接被拒绝';
      } else if (error?.message) {
        errorMsg = error.message.substring(0, 50);
      }

      return { link, isValid: false, isExpired: false, error: errorMsg };
    }
  }

  async validateLinks(links: SubscriptionLink[]): Promise<SubscriptionLink[]> {
    console.log(`\n🔍 开始验证 ${links.length} 个链接...`);
    console.log(`   超时设置: ${this.timeout / 1000} 秒`);
    console.log(`   并发数: ${this.concurrency}`);
    if (this.proxyUrl) {
      console.log(`   代理: ${this.proxyUrl}`);
    }
    if (this.maxDaysSinceSubUpdate) {
      console.log(`   订阅文件最大更新天数: ${this.maxDaysSinceSubUpdate} 天`);
    }
    console.log('');

    const startTime = Date.now();
    const results: ValidationResult[] = [];
    let completed = 0;

    for (let i = 0; i < links.length; i += this.concurrency) {
      const batch = links.slice(i, i + this.concurrency);
      const batchPromises = batch.map((link) => this.validateSingleLink(link));
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      completed += batch.length;
      batchResults.forEach((result, index) => {
        const globalIndex = i + index + 1;
        const progress = `[${globalIndex}/${links.length}]`;
        const shortUrl = result.link.url.substring(0, 60);

        if (result.isExpired) {
          console.log(`${progress} ⏰ ${shortUrl}... (过期)`);
        } else if (result.isValid) {
          console.log(`${progress} ✅ ${shortUrl}...`);
        } else {
          const errorIcon = this.getErrorIcon(result.error || '');
          console.log(`${progress} ${errorIcon} ${shortUrl}... (${result.error})`);
        }
      });

      const percentage = ((completed / links.length) * 100).toFixed(1);
      console.log(`   进度: ${completed}/${links.length} (${percentage}%)\n`);

      // 批次间延迟，避免突发流量
      if (i + this.concurrency < links.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    const validLinks = results.filter((r) => r.isValid && !r.isExpired).map((r) => r.link);
    const expiredCount = results.filter((r) => r.isExpired).length;
    const invalidCount = results.filter((r) => !r.isValid && !r.isExpired).length;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`\n📊 验证完成:`);
    console.log(`   ✅ 有效链接: ${validLinks.length} 个`);
    console.log(`   ❌ 无效链接: ${invalidCount} 个`);
    if (expiredCount > 0) {
      console.log(`   ⏰ 过期链接: ${expiredCount} 个`);
    }
    console.log(`   📈 有效率: ${((validLinks.length / links.length) * 100).toFixed(1)}%`);
    console.log(`   ⏱️  总耗时: ${elapsed}s\n`);

    // 节点数量统计
    const nodeStats = validLinks
      .filter(l => l.nodeCount !== undefined && l.nodeCount > 0)
      .map(l => l.nodeCount!);
    if (nodeStats.length > 0) {
      const totalNodes = nodeStats.reduce((sum, n) => sum + n, 0);
      const avgNodes = Math.round(totalNodes / nodeStats.length);
      const maxNodes = Math.max(...nodeStats);
      const minNodes = Math.min(...nodeStats);
      console.log(`📊 节点数量统计:`);
      console.log(`   📈 总节点数: ${totalNodes} 个`);
      console.log(`   📊 平均节点: ${avgNodes} 个/链接`);
      console.log(`   🔝 最多节点: ${maxNodes} 个`);
      console.log(`   🔻 最少节点: ${minNodes} 个\n`);
    }

    const errorResults = results.filter((r) => !r.isValid && !r.isExpired && r.error);
    if (errorResults.length > 0) {
      const errorStats = this.getErrorStatistics(errorResults);
      console.log(`📋 失败原因统计:`);
      for (const [error, count] of Object.entries(errorStats)) {
        console.log(`   ${this.getErrorIcon(error)} ${error}: ${count} 个`);
      }
      console.log('');
    }

    return validLinks;
  }

  private getErrorIcon(error: string): string {
    if (error.includes('超时')) return '⏱️';
    if (error.includes('域名')) return '🔍';
    if (error.includes('拒绝')) return '🚫';
    if (error.includes('HTTP')) return '❌';
    return '⚠️';
  }

  private getErrorStatistics(results: ValidationResult[]): Record<string, number> {
    const stats: Record<string, number> = {};
    results
      .filter((r) => r.error)
      .forEach((r) => {
        const error = r.error!;
        stats[error] = (stats[error] || 0) + 1;
      });
    return stats;
  }
}
