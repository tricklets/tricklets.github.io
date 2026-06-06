<!-- release-production
version=${REPLACE_VERSION}
staging_version=${REPLACE_STAGING_VERSION}
train_base=${REPLACE_TRAIN_BASE}
deploy_base=${REPLACE_DEPLOY_BASE}
target_sha=${REPLACE_TARGET_SHA}
stable_pr=${REPLACE_STABLE_PR}
-->
## Production Release ${REPLACE_VERSION}

本 PR は [Staging Release #${REPLACE_STABLE_PR}](../pull/${REPLACE_STABLE_PR}) にて承認されたリリースの Production 反映です。

**リリース予定日: ${REPLACE_PRD_DATE}**

リリースするには本プルリクエストをマージしてください。  
後続の Production リリース処理は GitHub Actions により自動実行されます。  
証跡管理のために承認者がマージを実行してください。

---

### Staging 判定書（抜粋）

${REPLACE_DETAILS}

${REPLACE_SCHEDULE}
