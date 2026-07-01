import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { SubscriptionLink } from './types';

/**
 * YAML 配置文件更新器
 * 职责: 将收集到的订阅链接更新到 config.yaml 的 sub-urls 部分
 */
export class ConfigUpdater {
  private configPath: string;

  constructor(configPath: string = './config.yaml') {
    this.configPath = configPath;
  }

  /**
   * 更新 config.yaml 中的 sub-urls
   * @param links 订阅链接列表
   */
  async updateSubUrls(links: SubscriptionLink[]): Promise<void> {
    try {
      console.log('\n📝 开始更新 config.yaml...');

      const fileContent = await fs.readFile(this.configPath, 'utf-8');

      const config = yaml.load(fileContent) as any;
      if (!config) {
        throw new Error('配置文件解析失败');
      }

      const oldCount = (config['sub-urls'] || []).length;
      const newUrls = this.extractValidUrls(links);

      await this.writeConfigWithComments(fileContent, newUrls);

      console.log(`✅ 配置文件已更新`);
      console.log(`   - 旧链接: ${oldCount} 个 (已清除)`);
      console.log(`   - 新链接: ${newUrls.size} 个\n`);
    } catch (error) {
      console.error('❌ 更新配置文件失败:', error);
      throw error;
    }
  }

  /**
   * 从订阅链接中提取有效的 URL（按节点数降序排序）
   */
  private extractValidUrls(links: SubscriptionLink[]): Set<string> {
    // 按节点数降序排序，节点数越多越靠前
    const sortedLinks = [...links].sort((a, b) => (b.nodeCount ?? 0) - (a.nodeCount ?? 0));

    const urls = new Set<string>();
    for (const link of sortedLinks) {
      const url = link.url;

      // 排除非订阅 URL
      if (this.isNonSubscriptionUrl(url)) continue;

      if (this.isSubscriptionUrl(url, link.type)) {
        urls.add(this.normalizeUrl(url));
      }
    }

    return urls;
  }

  /**
   * 判断是否为订阅 URL
   */
  private isSubscriptionUrl(url: string, type?: string): boolean {
    const lower = url.toLowerCase();

    // 1. 订阅文件扩展名
    if (/\.(txt|yaml|yml|conf|json|v2ray|clash|ss|ssr|vmess|vless|trojan)$/i.test(lower)) {
      return true;
    }

    // 2. 订阅相关路径关键字
    if (/\/sub($|\/)|\/subscription($|\/)|\/subscribe($|\/)|\/nodes($|\/)/i.test(lower)) {
      return true;
    }

    // 3. raw.githubusercontent.com 或 gist.githubusercontent.com 上的订阅仓库
    if (lower.includes('raw.githubusercontent.com') || lower.includes('gist.githubusercontent.com')) {
      // 排除明显的非订阅路径
      if (!/\/(actions|workflows|releases|issues|pull)\//i.test(lower)) {
        return true;
      }
    }

    // 4. 已知订阅格式的 URL（通过链接类型推断）
    if (type && ['V2Ray', 'Clash', 'Shadowsocks', 'Hysteria', 'TUIC', 'WireGuard'].includes(type)) {
      return true;
    }

    return false;
  }

  /**
   * 规范化 URL，用于去重
   * - host 转小写（防止同一网站大小写不同）
   * - 路径保持原始大小写（GitHub 路径区分大小写！）
   */
  private normalizeUrl(url: string): string {
    let normalized = url
      .replace(/[|`'"'\)>]+$/, '')
      .replace(/\/+$/, '')
      .replace(/^http:/, 'https:');

    // 去除 query 和 fragment，保持路径原始大小写
    try {
      const u = new URL(normalized);
      normalized = `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
      normalized = normalized.replace(/[?#].*$/, '');
    }

    // 统一 URL 编码大小写（%C3%BC → %c3%bc）
    normalized = normalized.replace(/%[0-9A-F]{2}/gi, (match) => match.toLowerCase());

    return normalized;
  }

  /**
   * 判断是否为非订阅 URL
   */
  private isNonSubscriptionUrl(url: string): boolean {
    const lower = url.toLowerCase();
    return [
      // 图片
      /\.svg$/i,
      /\.png$/i,
      /\.jpg$/i,
      /\.jpeg$/i,
      /\.gif$/i,
      /\.webp$/i,
      // 压缩包
      /\.zip$/i,
      /\.tar\.gz$/i,
      /\.tgz$/i,
      /\.rar$/i,
      /\.7z$/i,
      // 可执行文件
      /\.exe$/i,
      /\.msi$/i,
      /\.dmg$/i,
      // 徽章/二维码
      /qrserver/i,
      /quickchart/i,
      /badge/i,
      /shields\.io/i,
      /img\.shields/i,
      // GitHub actions
      /actions\/workflows/i,
      // 其他
      /translate\.yandex/i,
      /blacklist/i,
      /whitelist/i,
    ].some(p => p.test(lower));
  }

  private async writeConfigWithComments(
    originalContent: string,
    newUrls: Set<string>
  ): Promise<void> {
    const urlsBlock = Array.from(newUrls)
      .sort()
      .map((url) => `  - "${url}"`)
      .join('\n');

    // 找到 sub-urls: 所在行（排除注释行）
    const lines = originalContent.split('\n');
    let subUrlsStart = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === 'sub-urls:' && !lines[i].startsWith('#')) {
        subUrlsStart = i;
        break;
      }
    }
    if (subUrlsStart === -1) {
      throw new Error('未找到 sub-urls: 配置项');
    }

    // 从 sub-urls: 下一行开始，找到下一个顶级配置项的行号
    let subUrlsEnd = lines.length;
    for (let i = subUrlsStart + 1; i < lines.length; i++) {
      const line = lines[i];
      // 顶级配置项：非空、不以空格/tab开头、不是注释
      if (line.length > 0 && !/^[ \t]/.test(line) && !line.startsWith('#')) {
        subUrlsEnd = i;
        break;
      }
    }

    // 保留 sub-urls: 之前的全部内容 + sub-urls: 行本身 + 旧区块中的注释/空行 + 新URL + 后续全部内容
    const before = lines.slice(0, subUrlsStart + 1);
    const after = lines.slice(subUrlsEnd);

    // 从旧区块中只保留注释行和空行
    const oldSection = lines.slice(subUrlsStart + 1, subUrlsEnd);
    const keptLines = oldSection.filter(l => l.trim() === '' || l.trim().startsWith('#'));

    const result = [...before, ...keptLines, urlsBlock, ...after].join('\n');
    await fs.writeFile(this.configPath, result, 'utf-8');
  }

  /**
   * 备份配置文件
   */
  async backupConfig(): Promise<string> {
    const backupPath = `${this.configPath}.backup.${Date.now()}`;
    await fs.copyFile(this.configPath, backupPath);
    console.log(`💾 配置文件已备份: ${backupPath}`);
    await this.cleanupOldBackups();
    return backupPath;
  }

  /**
   * 清理旧的备份文件，只保留最近 3 个
   */
  private async cleanupOldBackups(): Promise<void> {
    try {
      const dir = path.dirname(this.configPath);
      const baseName = path.basename(this.configPath);
      const files = await fs.readdir(dir);
      const backups = files
        .filter(f => f.startsWith(`${baseName}.backup.`))
        .sort()
        .reverse();

      if (backups.length > 3) {
        for (const old of backups.slice(3)) {
          await fs.unlink(path.join(dir, old));
          console.log(`🗑️  已清理旧备份: ${old}`);
        }
      }
    } catch {
      // 忽略清理错误
    }
  }
}
