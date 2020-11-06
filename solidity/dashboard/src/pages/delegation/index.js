import React, { useEffect } from "react"
import { useLocation } from "react-router-dom"
import { connect } from "react-redux"
import TokensPageContextProvider, {
  useTokensPageContext,
} from "../../contexts/TokensPageContext"
import { SET_TOKENS_CONTEXT } from "../../reducers/tokens-page.reducer.js"
import { FETCH_DELEGATIONS_FROM_OLD_STAKING_CONTRACT_REQUEST } from "../../actions"
import { isEmptyArray } from "../../utils/array.utils"
import Banner, { BANNER_TYPE } from "../../components/Banner"
import Button from "../../components/Button"
import { useModal } from "../../hooks/useModal"
import CopyStakePage from "../CopyStakePage"
import PageWrapper from "../../components/PageWrapper"

import { WalletTokensPage } from "./WalletTokensPage"
import { GrantedTokensPage } from "./GrantedTokensPage"

const DelegationPage = ({
  title,
  routes,
  oldDelegations,
  fetchOldDelegations,
}) => {
  const { hash } = useLocation()
  const { dispatch } = useTokensPageContext()

  useEffect(() => {
    const tokenContext = hash.substring(1)
    if (tokenContext === "owned" || tokenContext === "granted") {
      dispatch({ type: SET_TOKENS_CONTEXT, payload: tokenContext })
    }
  }, [hash, dispatch])

  useEffect(() => {
    fetchOldDelegations()
  }, [fetchOldDelegations])

  const { openModal } = useModal()

  return (
    <PageWrapper title={title} routes={routes}>
      {!isEmptyArray(oldDelegations) && (
        <Banner
          type={BANNER_TYPE.NOTIFICATION}
          withIcon
          title="New upgrade available for your stake delegations!"
          titleClassName="h4"
          subtitle="Upgrade now to keep earning rewards on your stake."
        >
          <Button
            className="btn btn-tertiary btn-sm ml-a"
            onClick={() => openModal(<CopyStakePage />, { isFullScreen: true })}
          >
            upgrade my stake
          </Button>
        </Banner>
      )}
    </PageWrapper>
  )
}

const mapStateToProps = ({ copyStake }) => {
  const { oldDelegations } = copyStake

  return { oldDelegations }
}

const mapDispatchToProps = (dispatch) => {
  return {
    fetchOldDelegations: () =>
      dispatch({ type: FETCH_DELEGATIONS_FROM_OLD_STAKING_CONTRACT_REQUEST }),
  }
}

const DelegationPageWithRedux = connect(
  mapStateToProps,
  mapDispatchToProps
)(DelegationPage)

const DelegationPageWithContext = React.memo((props) => (
  <TokensPageContextProvider>
    <DelegationPageWithRedux {...props} />
  </TokensPageContextProvider>
))

DelegationPageWithContext.route = {
  title: "Delegation",
  path: "/delegation",
  pages: [WalletTokensPage, GrantedTokensPage],
}

export default DelegationPageWithContext