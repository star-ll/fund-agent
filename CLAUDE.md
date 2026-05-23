# 开发规范

## Git 工作流

每次新需求必须从主分支切出新分支开发，完成后合并回主分支并推送：

```bash
git checkout master
git pull
git checkout -b <feature-branch>
# 开发...
git checkout master
git merge <feature-branch>
git push
```

分支命名建议：`feature/<简短描述>`，如 `feature/user-profile-enrichment`。
